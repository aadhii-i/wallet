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
	req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: method, Params: paramsJSON}
	timeout := methodTimeout(method)
	var lastErr error
	for _, prov := range p.candidates() {
		resp, err := prov.call(ctx, p.chainLabel(), req, timeout)
		if err != nil {
			prov.recordFailure()
			lastErr = err
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
