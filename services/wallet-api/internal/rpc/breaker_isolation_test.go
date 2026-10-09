package rpc_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/rpc"
)

// TestHeavyMethodTimeoutDoesNotOpenBreakerForOtherMethods reproduces the
// scenario where one caller sends a slow eth_call (a client-parameterized
// "heavy" method) that times out repeatedly; that must not open the shared
// circuit breaker and start failing plain eth_blockNumber calls for
// everyone else on the same provider.
func TestHeavyMethodTimeoutDoesNotOpenBreakerForOtherMethods(t *testing.T) {
	block := make(chan struct{})
	callCount := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Method == "eth_call" {
			callCount++
			<-block // always times out
			return
		}
		// Fast, healthy response for everything else.
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": "0x2a"}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer func() {
		close(block)
		up.Close()
	}()

	registry := evm.NewRegistry(map[int64]int{31337: 1})
	pool := rpc.NewPool(31337, []rpc.Upstream{{Name: "only", URL: up.URL}}, nil)
	mgr := rpc.NewManager(registry, map[int64]*rpc.Pool{31337: pool})
	handler := rpc.NewHandler(mgr)

	router := chi.NewRouter()
	router.Post("/v1/rpc/evm/{chainId}", handler.ServeHTTP)
	srv := httptest.NewServer(router)
	defer srv.Close()

	post := func(body string) map[string]any {
		resp, err := http.Post(srv.URL+"/v1/rpc/evm/31337", "application/json", bytes.NewReader([]byte(body)))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var decoded map[string]any
		json.NewDecoder(resp.Body).Decode(&decoded)
		return decoded
	}

	// Five consecutive eth_call timeouts: enough to open the breaker if they
	// counted as provider failures (consecutiveFailuresToOpen == 5).
	for i := 0; i < 5; i++ {
		resp := post(`{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x0","data":"0x"},"latest"]}`)
		if _, ok := resp["error"]; !ok {
			t.Fatalf("expected the timed-out eth_call to surface an error, got %v", resp)
		}
	}

	// A plain eth_blockNumber call must still succeed: the breaker must not
	// have been opened by the eth_call timeouts.
	resp := post(`{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}`)
	if resp["result"] != "0x2a" {
		t.Fatalf("expected eth_blockNumber to still succeed (breaker must not be open), got %v", resp)
	}
}
