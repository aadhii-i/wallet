package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/qdwallet/wallet-api/internal/platform/metrics"
	"golang.org/x/time/rate"
)

// circuitState is a classic 3-state circuit breaker.
type circuitState int

const (
	circuitClosed circuitState = iota
	circuitOpen
	circuitHalfOpen
)

const (
	consecutiveFailuresToOpen = 5
	openDuration              = 30 * time.Second
	healthCheckInterval       = 10 * time.Second
	headLagDemoteThreshold    = 3
)

// Provider is one upstream RPC endpoint. The URL is never logged or
// exposed to clients; only Name is. Even error logging must never include
// URL or err.Error() from a raw *url.Error, since that embeds the full
// request URL -- which for most providers includes the API key as a path
// segment or query parameter.
type Provider struct {
	Name string
	URL  string

	httpClient *http.Client
	limiter    *rate.Limiter
	logger     *slog.Logger

	mu               sync.Mutex
	state            circuitState
	consecutiveFails int
	openedAt         time.Time
	healthy          bool
	headBlock        uint64
	// chainVerified is set once the upstream's eth_chainId matched the pool's
	// chain; wrongChain once it did not. A wrong-chain provider is never used
	// again: a Mainnet URL configured under EVM_RPC_11155111 would otherwise
	// serve Mainnet balances labelled as Sepolia.
	chainVerified bool
	wrongChain    bool
}

func newProvider(name, url string, logger *slog.Logger) *Provider {
	if logger == nil {
		logger = slog.Default()
	}
	return &Provider{
		Name:       name,
		URL:        url,
		httpClient: &http.Client{},
		limiter:    rate.NewLimiter(rate.Limit(50), 100),
		logger:     logger,
		healthy:    true,
	}
}

// heavyClientMethods are read methods whose latency/timeout behaviour is
// substantially controlled by client-supplied parameters (a wide
// eth_getLogs range, an expensive eth_call/eth_estimateGas payload). A
// timeout on one of these must not count against the shared provider
// circuit breaker, or a single abusive caller could open the breaker for
// every other user of that provider. Transport errors, non-2xx responses,
// and health-probe failures always count regardless of method.
var heavyClientMethods = map[string]struct{}{
	"eth_call":        {},
	"eth_estimateGas": {},
	"eth_getLogs":     {},
}

// shouldCountAsProviderFailure decides whether err, encountered while
// calling method, should be recorded against the provider's circuit
// breaker. Only a context-deadline timeout on a heavy, client-parameterized
// method is excluded; everything else (connection errors, non-2xx, decode
// failures, timeouts on other methods) counts as before.
func shouldCountAsProviderFailure(err error, method string) bool {
	if _, heavy := heavyClientMethods[method]; heavy && errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return true
}

// sanitizeUpstreamErr strips any upstream URL (and therefore any embedded
// API key) from a transport error, returning only the unwrapped underlying
// cause (e.g. "context deadline exceeded", "connection refused"). Go's HTTP
// client wraps transport errors in a *url.Error whose Error() string
// includes the full request URL, so this must never be skipped.
func sanitizeUpstreamErr(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

// allowRequest checks (and, for half-open, transitions) the circuit state.
func (p *Provider) allowRequest() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.wrongChain {
		return false
	}
	switch p.state {
	case circuitOpen:
		if time.Since(p.openedAt) >= openDuration {
			p.state = circuitHalfOpen
			return true
		}
		return false
	default:
		return true
	}
}

func (p *Provider) recordSuccess() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consecutiveFails = 0
	p.state = circuitClosed
}

func (p *Provider) recordFailure() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consecutiveFails++
	if p.state == circuitHalfOpen || p.consecutiveFails >= consecutiveFailuresToOpen {
		p.state = circuitOpen
		p.openedAt = time.Now()
	}
}

func (p *Provider) isOpen() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state == circuitOpen && time.Since(p.openedAt) < openDuration
}

func (p *Provider) setHealth(healthy bool, head uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.healthy = healthy
	p.headBlock = head
}

func (p *Provider) Healthy() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.healthy && p.state != circuitOpen && !p.wrongChain
}

// WrongChain reports whether the upstream answered eth_chainId with a chain
// other than the one it is configured for.
func (p *Provider) WrongChain() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.wrongChain
}

// rpcEnvelope is a minimal JSON-RPC 2.0 request/response envelope.
type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// call sends one JSON-RPC request to the provider with the given timeout.
func (p *Provider) call(ctx context.Context, chainIDLabel string, req rpcEnvelope, timeout time.Duration) (*rpcEnvelope, error) {
	if !p.limiter.Allow() {
		return nil, fmt.Errorf("rpc: provider %s rate limited", p.Name)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := p.httpClient.Do(httpReq)
	duration := time.Since(start)
	metrics.RPCUpstreamDuration.WithLabelValues(chainIDLabel, p.Name, req.Method).Observe(duration.Seconds())
	if err != nil {
		cause := sanitizeUpstreamErr(err)
		metrics.RPCUpstreamErrors.WithLabelValues(chainIDLabel, p.Name, req.Method, "transport").Inc()
		// Log provider name + unwrapped cause only -- never the raw error,
		// which for a *url.Error includes the full upstream URL (and thus
		// any API key baked into it).
		p.logger.Error("rpc upstream request failed",
			slog.String("provider", p.Name),
			slog.String("chain_id", chainIDLabel),
			slog.String("method", req.Method),
			slog.String("cause", cause.Error()),
		)
		return nil, fmt.Errorf("rpc: provider %s: %w", p.Name, cause)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		metrics.RPCUpstreamErrors.WithLabelValues(chainIDLabel, p.Name, req.Method, "http_status").Inc()
		p.logger.Error("rpc upstream returned non-2xx",
			slog.String("provider", p.Name),
			slog.String("chain_id", chainIDLabel),
			slog.String("method", req.Method),
			slog.Int("status", resp.StatusCode),
		)
		return nil, fmt.Errorf("rpc: provider %s returned HTTP %d", p.Name, resp.StatusCode)
	}
	var out rpcEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		metrics.RPCUpstreamErrors.WithLabelValues(chainIDLabel, p.Name, req.Method, "decode").Inc()
		return nil, fmt.Errorf("rpc: provider %s: decode response: %w", p.Name, err)
	}
	return &out, nil
}

// Pool manages the ordered set of providers for one chain.
type Pool struct {
	chainID   int64
	providers []*Provider
}

// NewPool builds a provider pool for one chain. logger may be nil, in which
// case slog.Default() is used.
func NewPool(chainID int64, upstreams []Upstream, logger *slog.Logger) *Pool {
	p := &Pool{chainID: chainID}
	for _, u := range upstreams {
		p.providers = append(p.providers, newProvider(u.Name, u.URL, logger))
	}
	return p
}

// Upstream mirrors config.RPCUpstream without importing the config
// package, keeping internal/rpc free of a config dependency.
type Upstream struct {
	Name string
	URL  string
}

func (p *Pool) chainLabel() string { return strconv.FormatInt(p.chainID, 10) }

// candidates returns providers in priority order, skipping open-circuit
// ones, for a read method's failover attempts.
func (p *Pool) candidates() []*Provider {
	out := make([]*Provider, 0, len(p.providers))
	for _, prov := range p.providers {
		if prov.allowRequest() {
			out = append(out, prov)
		}
	}
	if len(out) == 0 {
		// Every circuit is open: still try the providers so the system
		// fails loudly rather than refusing all traffic silently -- but
		// never one serving the wrong chain.
		for _, prov := range p.providers {
			if !prov.WrongChain() {
				out = append(out, prov)
			}
		}
	}
	return out
}

// ByName returns the first provider with the given name (used for the
// Alchemy history provider integration).
func (p *Pool) ByName(name string) (*Provider, bool) {
	for _, prov := range p.providers {
		if prov.Name == name {
			return prov, true
		}
	}
	return nil, false
}

func (p *Pool) Providers() []*Provider { return p.providers }

// StartHealthChecks launches the periodic eth_blockNumber probe (spec §25.2)
// until ctx is cancelled.
func (p *Pool) StartHealthChecks(ctx context.Context) {
	ticker := time.NewTicker(healthCheckInterval)
	go func() {
		defer ticker.Stop()
		p.checkHealthOnce(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				p.checkHealthOnce(ctx)
			}
		}
	}()
}

func (p *Pool) checkHealthOnce(ctx context.Context) {
	var best uint64
	heads := make(map[*Provider]uint64, len(p.providers))
	for _, prov := range p.providers {
		if !p.verifyChain(ctx, prov) {
			prov.setHealth(false, 0)
			metrics.RPCProviderHealthy.WithLabelValues(p.chainLabel(), prov.Name).Set(0)
			continue
		}
		req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "eth_blockNumber"}
		resp, err := prov.call(ctx, p.chainLabel(), req, 3*time.Second)
		if err != nil || resp.Error != nil {
			prov.recordFailure()
			prov.setHealth(false, 0)
			metrics.RPCProviderHealthy.WithLabelValues(p.chainLabel(), prov.Name).Set(0)
			continue
		}
		prov.recordSuccess()
		var hexBlock string
		_ = json.Unmarshal(resp.Result, &hexBlock)
		head, _ := parseHexBlock(hexBlock)
		heads[prov] = head
		if head > best {
			best = head
		}
	}
	for prov, head := range heads {
		lag := int64(best) - int64(head)
		healthy := lag <= headLagDemoteThreshold
		prov.setHealth(healthy, head)
		val := 0.0
		if healthy {
			val = 1.0
		}
		metrics.RPCProviderHealthy.WithLabelValues(p.chainLabel(), prov.Name).Set(val)
		metrics.RPCProviderHeadLag.WithLabelValues(p.chainLabel(), prov.Name).Set(float64(lag))
	}
}

// verifyChain checks, once per provider, that the upstream's eth_chainId is
// the chain this pool serves. It returns false while the check has not
// succeeded (unreachable upstream) or after it found a mismatch.
func (p *Pool) verifyChain(ctx context.Context, prov *Provider) bool {
	prov.mu.Lock()
	verified, wrong := prov.chainVerified, prov.wrongChain
	prov.mu.Unlock()
	if wrong {
		return false
	}
	if verified {
		return true
	}
	req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "eth_chainId"}
	resp, err := prov.call(ctx, p.chainLabel(), req, 3*time.Second)
	if err != nil || resp.Error != nil {
		prov.recordFailure()
		return false
	}
	var hexID string
	_ = json.Unmarshal(resp.Result, &hexID)
	got, ok := parseHexBlock(hexID)
	prov.mu.Lock()
	defer prov.mu.Unlock()
	if !ok || got != uint64(p.chainID) {
		prov.wrongChain = true
		// Provider name and chain ids only -- never the URL.
		prov.logger.Error("rpc upstream serves a different chain; provider disabled",
			slog.String("provider", prov.Name),
			slog.String("chain_id", p.chainLabel()),
			slog.String("upstream_chain_id", hexID),
		)
		return false
	}
	prov.chainVerified = true
	return true
}
