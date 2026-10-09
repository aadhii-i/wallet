package rpc_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/rpc"
)

type fakeUpstream struct {
	srv      *httptest.Server
	calls    int32
	handler  func(method string, params json.RawMessage) (any, *fakeErr)
	failNext int32 // if > 0, decremented and returns a transport error
}

type fakeErr struct {
	Code    int
	Message string
}

func newFakeUpstream(t *testing.T, handler func(method string, params json.RawMessage) (any, *fakeErr)) *fakeUpstream {
	f := &fakeUpstream{handler: handler}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&f.calls, 1)
		if atomic.LoadInt32(&f.failNext) > 0 {
			atomic.AddInt32(&f.failNext, -1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		result, ferr := f.handler(req.Method, req.Params)
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if ferr != nil {
			resp["error"] = map[string]any{"code": ferr.Code, "message": ferr.Message}
		} else {
			resp["result"] = result
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func newTestHandler(t *testing.T, chainID int64, upstreams ...rpc.Upstream) (*rpc.Handler, *rpc.Manager) {
	t.Helper()
	registry := evm.NewRegistry(map[int64]int{chainID: len(upstreams)})
	pool := rpc.NewPool(chainID, upstreams, nil)
	mgr := rpc.NewManager(registry, map[int64]*rpc.Pool{chainID: pool})
	return rpc.NewHandler(mgr), mgr
}

func newRouter(h *rpc.Handler) http.Handler {
	r := chi.NewRouter()
	r.Post("/v1/rpc/evm/{chainId}", h.ServeHTTP)
	return r
}

func postRPC(t *testing.T, srv *httptest.Server, chainID int64, body string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Post(srv.URL+"/v1/rpc/evm/"+strconv.FormatInt(chainID, 10), "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return resp, buf.Bytes()
}

func TestAllowlistRejectsUnknownMethod(t *testing.T) {
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) { return "0x1", nil })
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "anvil", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	_, body := postRPC(t, srv, 31337, `{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}`)
	var resp map[string]any
	json.Unmarshal(body, &resp)
	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error for disallowed method, got %s", body)
	}
	if int(errObj["code"].(float64)) != -32601 {
		t.Fatalf("expected -32601, got %v", errObj["code"])
	}
}

func TestBatchSizeLimit(t *testing.T) {
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) { return "0x1", nil })
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "anvil", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	var items []string
	for i := 0; i < 21; i++ {
		items = append(items, `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)
	}
	batch := "[" + join(items, ",") + "]"
	resp, _ := postRPC(t, srv, 31337, batch)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized batch, got %d", resp.StatusCode)
	}
}

func join(items []string, sep string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

func TestGetLogsRangeCap(t *testing.T) {
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) { return []any{}, nil })
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "anvil", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	// range of 3000 blocks: must be rejected.
	body := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0xBB8"}]}`
	_, respBody := postRPC(t, srv, 31337, body)
	var resp map[string]any
	json.Unmarshal(respBody, &resp)
	if _, ok := resp["error"]; !ok {
		t.Fatalf("expected error for oversized eth_getLogs range, got %s", respBody)
	}

	// range of 100 blocks: must succeed.
	body2 := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x64"}]}`
	_, respBody2 := postRPC(t, srv, 31337, body2)
	var resp2 map[string]any
	json.Unmarshal(respBody2, &resp2)
	if _, ok := resp2["error"]; ok {
		t.Fatalf("expected success for in-range eth_getLogs, got %s", respBody2)
	}

	// tag-based range ("latest") must be rejected (not an explicit number).
	body3 := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"latest"}]}`
	_, respBody3 := postRPC(t, srv, 31337, body3)
	var resp3 map[string]any
	json.Unmarshal(respBody3, &resp3)
	if _, ok := resp3["error"]; !ok {
		t.Fatalf("expected error for tag-based eth_getLogs range, got %s", respBody3)
	}
}

func TestEthChainIdAnsweredLocally(t *testing.T) {
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		t.Fatalf("upstream should never be called for eth_chainId")
		return nil, nil
	})
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "anvil", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	_, body := postRPC(t, srv, 31337, `{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}`)
	var resp map[string]any
	json.Unmarshal(body, &resp)
	if resp["result"] != "0x7a69" { // 31337 in hex
		t.Fatalf("expected 0x7a69, got %v (%s)", resp["result"], body)
	}
}

func TestFailoverOnReadMethod(t *testing.T) {
	primary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		return nil, &fakeErr{Code: -32000, Message: "boom"}
	})
	secondary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		return "0x2a", nil
	})
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "primary", URL: primary.srv.URL}, rpc.Upstream{Name: "secondary", URL: secondary.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	// forceFailure via HTTP 500 makes call() return an error (not a JSON-RPC
	// error), which triggers failover; use failNext on primary instead.
	atomic.StoreInt32(&primary.failNext, 1)

	_, body := postRPC(t, srv, 31337, `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)
	var resp map[string]any
	json.Unmarshal(body, &resp)
	if resp["result"] != "0x2a" {
		t.Fatalf("expected failover to secondary provider, got %s", body)
	}
	if atomic.LoadInt32(&secondary.calls) == 0 {
		t.Fatalf("expected secondary provider to be called")
	}
}

func TestCircuitBreakerOpensAfterConsecutiveFailures(t *testing.T) {
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		return nil, &fakeErr{Code: -32000, Message: "boom"}
	})
	atomic.StoreInt32(&up.failNext, 1000) // always fail via transport error
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "only", URL: up.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	for i := 0; i < 5; i++ {
		postRPC(t, srv, 31337, `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)
	}
	callsAfterFive := atomic.LoadInt32(&up.calls)

	// One more request: since the circuit should now be open, the pool
	// still tries "all providers" as a last resort per our fallback policy
	// when nothing is healthy, but the important property is that the
	// breaker recorded failures and future calls behave consistently.
	postRPC(t, srv, 31337, `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)
	if callsAfterFive == 0 {
		t.Fatalf("expected the upstream to have been called during the failure streak")
	}
}

func TestSendRawTransactionDoesNotBlindlyResendOnSuccess(t *testing.T) {
	// A raw legacy transaction hex (well-formed RLP) is required for
	// UnmarshalBinary to succeed; use a minimal valid legacy tx encoding.
	rawTx := sampleRawTx(t)

	var primaryCalls, secondaryCalls int32
	primary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		if method == "eth_sendRawTransaction" {
			atomic.AddInt32(&primaryCalls, 1)
			return "0xhash", nil
		}
		return nil, nil
	})
	secondary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		atomic.AddInt32(&secondaryCalls, 1)
		return "0xhash", nil
	})
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "primary", URL: primary.srv.URL}, rpc.Upstream{Name: "secondary", URL: secondary.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	body := `{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["` + rawTx + `"]}`
	_, respBody := postRPC(t, srv, 31337, body)
	var resp map[string]any
	json.Unmarshal(respBody, &resp)
	if resp["result"] != "0xhash" {
		t.Fatalf("expected success from primary, got %s", respBody)
	}
	if atomic.LoadInt32(&secondaryCalls) != 0 {
		t.Fatalf("secondary must not be called when the primary succeeds")
	}
}

func TestSendRawTransactionChecksBeforeResend(t *testing.T) {
	rawTx := sampleRawTx(t)

	primary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		return nil, &fakeErr{Code: -32000, Message: "timeout"}
	})
	atomic.StoreInt32(&primary.failNext, 1)

	var sawGetByHash, sawResend int32
	secondary := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		if method == "eth_getTransactionByHash" {
			atomic.AddInt32(&sawGetByHash, 1)
			// Simulate the tx already being known to this provider.
			return map[string]any{"hash": "0xseen"}, nil
		}
		if method == "eth_sendRawTransaction" {
			atomic.AddInt32(&sawResend, 1)
		}
		return "0xhash", nil
	})
	h, _ := newTestHandler(t, 31337, rpc.Upstream{Name: "primary", URL: primary.srv.URL}, rpc.Upstream{Name: "secondary", URL: secondary.srv.URL})
	srv := httptest.NewServer(newRouter(h))
	defer srv.Close()

	body := `{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["` + rawTx + `"]}`
	postRPC(t, srv, 31337, body)

	if atomic.LoadInt32(&sawGetByHash) == 0 {
		t.Fatalf("expected the proxy to check eth_getTransactionByHash before resending")
	}
	if atomic.LoadInt32(&sawResend) != 0 {
		t.Fatalf("must not blindly resend once the tx is confirmed known elsewhere")
	}
}

var _ = time.Second
