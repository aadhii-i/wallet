package rpc

import (
	"context"
	"encoding/json"
	"errors"
)

// Call is the exported entry point other internal packages (transaction
// tracker, EVM history scanner) use to make a single JSON-RPC read call
// through the same provider pool, health checks, and circuit breakers as
// the public proxy. method must be one of the allowlisted read methods.
func (p *Pool) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	if method == "eth_sendRawTransaction" {
		// Never retried or shared: see ratelimit.go.
		return p.callOnce(ctx, method, paramsJSON)
	}
	key := method + "\x00" + string(paramsJSON)
	if isBackground(ctx) {
		key = "bg\x00" + key
	}
	return p.reads.shared(ctx, key, method, func(ctx context.Context) (json.RawMessage, error) {
		return p.callRead(ctx, method, paramsJSON)
	})
}

// callRead is one read with foreground retries on HTTP 429. Background
// callers are not retried here: they wait their turn in callOnce, and their
// loops (indexer, gas monitor) retry on their own schedule.
func (p *Pool) callRead(ctx context.Context, method string, paramsJSON json.RawMessage) (json.RawMessage, error) {
	tries := foregroundTries
	if isBackground(ctx) {
		tries = 1
	}
	for n := 0; ; n++ {
		out, err := p.callOnce(ctx, method, paramsJSON)
		var rl *RateLimitedError
		if err == nil || !errors.As(err, &rl) || n+1 >= tries {
			return out, err
		}
		if werr := sleepCtx(ctx, retryWait(n, rl.RetryAfter)); werr != nil {
			return nil, err
		}
	}
}

// callOnce tries each candidate provider once, in failover order.
func (p *Pool) callOnce(ctx context.Context, method string, paramsJSON json.RawMessage) (json.RawMessage, error) {
	req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: method, Params: paramsJSON}
	timeout := methodTimeout(method)
	bg := isBackground(ctx)
	var lastErr error
	for _, prov := range p.candidates() {
		if bg {
			if err := prov.awaitBackgroundTurn(ctx); err != nil {
				return nil, err
			}
		}
		resp, err := prov.call(ctx, p.chainLabel(), req, timeout)
		if err != nil {
			if shouldCountAsProviderFailure(err, method) {
				prov.recordFailure()
			}
			lastErr = err
			if ctx.Err() != nil {
				break
			}
			continue
		}
		if resp.Error != nil {
			prov.recordFailure()
			lastErr = errors.New(resp.Error.Message)
			continue
		}
		prov.recordSuccess()
		return resp.Result, nil
	}
	if lastErr == nil {
		lastErr = errors.New("rpc: no upstream providers configured")
	}
	return nil, lastErr
}

// ManagerFor is a convenience the transaction tracker and history providers
// use to get a chain's pool without depending on the full Manager type.
func (m *Manager) ChainPool(chainID int64) (*Pool, bool) { return m.Pool(chainID) }

// NamedCaller returns a caller restricted to the single provider with the
// given name (e.g. "alchemy"), for history providers that need a specific
// upstream's non-standard JSON-RPC methods rather than the generic pool.
func (p *Pool) NamedCaller(name string) (*namedProviderCaller, bool) {
	prov, ok := p.ByName(name)
	if !ok {
		return nil, false
	}
	return &namedProviderCaller{pool: p, provider: prov}, true
}

type namedProviderCaller struct {
	pool     *Pool
	provider *Provider
}

func (c *namedProviderCaller) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: method, Params: paramsJSON}
	resp, err := c.provider.call(ctx, c.pool.chainLabel(), req, methodTimeout(method))
	if err != nil {
		c.provider.recordFailure()
		return nil, err
	}
	if resp.Error != nil {
		c.provider.recordFailure()
		return nil, errors.New(resp.Error.Message)
	}
	c.provider.recordSuccess()
	return resp.Result, nil
}
