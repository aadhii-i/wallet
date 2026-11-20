package rpc_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/rpc"
)

// TestClientCancellationDoesNotOpenBreaker: browsers abort in-flight requests
// whenever a page navigates. Those cancellations say nothing about the
// upstream, so they must not open the shared circuit breaker. Before the fix,
// a few navigations made a healthy node answer "upstream unavailable" to
// every user of the chain.
func TestClientCancellationDoesNotOpenBreaker(t *testing.T) {
	// upstream answers result after an optional delay; it honours cancellation.
	upstream := func(result string, slow *atomic.Bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				ID json.RawMessage `json:"id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			if slow != nil && slow.Load() {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(2 * time.Second):
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		}))
	}
	var slow atomic.Bool
	slow.Store(true)
	primary := upstream("0x1", &slow)
	defer primary.Close()
	secondary := upstream("0x2", nil)
	defer secondary.Close()

	registry := evm.NewRegistry(map[int64]int{31337: 1})
	pool := rpc.NewPool(31337, []rpc.Upstream{{Name: "primary", URL: primary.URL}, {Name: "secondary", URL: secondary.URL}}, nil)
	handler := rpc.NewHandler(rpc.NewManager(registry, map[int64]*rpc.Pool{31337: pool}))
	router := chi.NewRouter()
	router.Post("/v1/rpc/evm/{chainId}", handler.ServeHTTP)
	srv := httptest.NewServer(router)
	defer srv.Close()

	call := func(ctx context.Context) (map[string]any, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/v1/rpc/evm/31337",
			bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		var out map[string]any
		return out, json.NewDecoder(resp.Body).Decode(&out)
	}

	// More client cancellations than the breaker's failure threshold (5).
	for i := 0; i < 12; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_, _ = call(ctx)
		cancel()
	}
	time.Sleep(100 * time.Millisecond) // let the server observe the cancellations

	// The primary is healthy and its breaker closed, so it still serves the next
	// read. Had the cancellations opened its breaker, the read would move to the
	// secondary ("0x2").
	slow.Store(false)
	out, err := call(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if out["result"] != "0x1" {
		t.Fatalf("client cancellations opened the primary's circuit breaker: next read served by %v", out)
	}
}
