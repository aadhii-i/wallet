package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Every backend user of a chain (the conventional wallet's proxy, the
// transaction tracker, the shared-wallet relayer and gas estimate, the chain
// indexer and the gas monitor) shares that chain's Pool, and so its provider
// quota. Background work (chain indexing) must never consume the quota
// a waiting user or the relayer needs, so the pool:
//
//   - paces background calls per provider (SetBackgroundRate), and holds them
//     back entirely while a provider is cooling down after an HTTP 429;
//   - puts providers that are cooling down last in the failover order;
//   - retries foreground reads that were rate limited, with exponential
//     backoff, full jitter and the provider's Retry-After, a few times only;
//   - never retries eth_sendRawTransaction: its existing broadcast policy
//     (persist first, resend only the identical bytes) is left untouched;
//   - shares one upstream call between identical concurrent reads, and
//     caches the few reads whose answer is the same for every caller for a
//     moment (chain id, head block, fee suggestions).

type backgroundKey struct{}

// Background marks ctx as background work: its calls use the slow lane.
func Background(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}

func isBackground(ctx context.Context) bool {
	v, _ := ctx.Value(backgroundKey{}).(bool)
	return v
}

// BackgroundCaller wraps a pool so that every call through it is background work.
func BackgroundCaller(p *Pool) *backgroundCaller { return &backgroundCaller{p} }

type backgroundCaller struct{ p *Pool }

func (b *backgroundCaller) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return b.p.Call(Background(ctx), method, params)
}

// RateLimitedError describes temporary upstream or local admission pressure.
// Upstream errors keep the "returned HTTP 429" wording callers match on.
type RateLimitedError struct {
	Provider   string
	RetryAfter time.Duration
	Local      bool
}

func (e *RateLimitedError) Error() string {
	if e.Local {
		return fmt.Sprintf("rpc: provider %s local request quota exhausted", e.Provider)
	}
	return fmt.Sprintf("rpc: provider %s returned HTTP %d", e.Provider, http.StatusTooManyRequests)
}

// IsRateLimited reports an upstream HTTP 429 or local provider quota exhaustion.
func IsRateLimited(err error) bool {
	var r *RateLimitedError
	return errors.As(err, &r)
}

const (
	cooldownMin      = time.Second
	cooldownMax      = 30 * time.Second
	retryAfterMax    = 60 * time.Second
	foregroundTries  = 4 // 1 call + 3 retries
	foregroundWaitHi = 4 * time.Second
	backoffBase      = 250 * time.Millisecond
)

// retryRead gives foreground reads bounded retries for temporary throttling.
// Background callers leave retries to their own scheduling loops.
func retryRead(ctx context.Context, call func(context.Context) (json.RawMessage, error)) (json.RawMessage, error) {
	tries := foregroundTries
	if isBackground(ctx) {
		tries = 1
	}
	for n := 0; ; n++ {
		out, err := call(ctx)
		var limited *RateLimitedError
		if !errors.As(err, &limited) || n+1 >= tries {
			return out, err
		}
		if waitErr := sleepCtx(ctx, retryWait(n, limited.RetryAfter)); waitErr != nil {
			return nil, waitErr
		}
	}
}

// parseRetryAfter reads a Retry-After header: delta seconds or an HTTP date.
func parseRetryAfter(h string, now time.Time) time.Duration {
	if h == "" {
		return 0
	}
	var d time.Duration
	if s, err := strconv.Atoi(h); err == nil {
		d = time.Duration(s) * time.Second
	} else if t, err := http.ParseTime(h); err == nil {
		d = t.Sub(now)
	}
	if d < 0 {
		return 0
	}
	return min(d, retryAfterMax)
}

// noteRateLimited starts (or lengthens) the provider's cooldown: doubling
// from cooldownMin to cooldownMax on consecutive 429s, never shorter than
// the provider's Retry-After.
func (p *Provider) noteRateLimited(retryAfter time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cooldownStep == 0 {
		p.cooldownStep = cooldownMin
	} else {
		p.cooldownStep = min(p.cooldownStep*2, cooldownMax)
	}
	p.cooldownUntil = time.Now().Add(max(p.cooldownStep, retryAfter))
}

// coolingFor is how long the provider's 429 cooldown still lasts.
func (p *Provider) coolingFor() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return max(time.Until(p.cooldownUntil), 0)
}

// SetBackgroundRate limits background calls to rps per provider (rps <= 0:
// unlimited, the default; local chains keep it).
func (p *Pool) SetBackgroundRate(rps float64) {
	for _, prov := range p.providers {
		if rps <= 0 {
			prov.bgLimiter = nil
		} else {
			prov.bgLimiter = rate.NewLimiter(rate.Limit(rps), max(1, int(rps)))
		}
	}
}

// awaitBackgroundTurn holds a background call until the provider is out of
// its cooldown and the background lane has room.
func (prov *Provider) awaitBackgroundTurn(ctx context.Context) error {
	if d := prov.coolingFor(); d > 0 {
		if err := sleepCtx(ctx, d); err != nil {
			return err
		}
	}
	if prov.bgLimiter != nil {
		return prov.bgLimiter.Wait(ctx)
	}
	return nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// retryWait is the full-jitter exponential backoff before foreground retry
// n (0-based), never shorter than what the provider asked for.
func retryWait(n int, retryAfter time.Duration) time.Duration {
	ceil := min(backoffBase<<n, foregroundWaitHi)
	d := time.Duration(rand.Int64N(int64(ceil)) + 1)
	return min(max(d, retryAfter), foregroundWaitHi)
}

// cacheTTL: reads whose answer is the same for every caller, briefly cached.
func cacheTTL(method string) time.Duration {
	switch method {
	case "eth_chainId":
		return time.Hour
	case "eth_blockNumber":
		return time.Second
	case "eth_gasPrice", "eth_maxPriorityFeePerGas":
		return 2 * time.Second
	}
	return 0
}

type cached struct {
	val json.RawMessage
	at  time.Time
}

type flight struct {
	done chan struct{}
	val  json.RawMessage
	err  error
}

// readShare holds a pool's in-flight and cached reads.
type readShare struct {
	mu       sync.Mutex
	inflight map[string]*flight
	cache    map[string]cached
}

// shared runs fn once for all concurrent identical reads (key), and serves
// cacheable methods from a short cache. A caller that gives up stops
// waiting; the shared call finishes for the others.
func (s *readShare) shared(ctx context.Context, key, method string, fn func(context.Context) (json.RawMessage, error)) (json.RawMessage, error) {
	ttl := cacheTTL(method)
	s.mu.Lock()
	if s.inflight == nil {
		s.inflight, s.cache = map[string]*flight{}, map[string]cached{}
	}
	if c, ok := s.cache[key]; ok && ttl > 0 && time.Since(c.at) < ttl {
		s.mu.Unlock()
		return c.val, nil
	}
	f, running := s.inflight[key]
	if !running {
		f = &flight{done: make(chan struct{})}
		s.inflight[key] = f
		go func() {
			// Detached from the first caller: the others may still be waiting.
			f.val, f.err = fn(context.WithoutCancel(ctx))
			s.mu.Lock()
			delete(s.inflight, key)
			if f.err == nil && ttl > 0 {
				s.cache[key] = cached{f.val, time.Now()}
			}
			s.mu.Unlock()
			close(f.done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-f.done:
		return f.val, f.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
