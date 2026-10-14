package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// chainUpstream answers eth_chainId with chainHex and eth_blockNumber with 0x10.
func chainUpstream(t *testing.T, chainHex string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcEnvelope
		_ = json.NewDecoder(r.Body).Decode(&req)
		result := `"0x10"`
		if req.Method == "eth_chainId" {
			result = `"` + chainHex + `"`
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + result + `}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHealthCheckDisablesWrongChainUpstream(t *testing.T) {
	sepolia := chainUpstream(t, "0xaa36a7") // 11155111
	mainnet := chainUpstream(t, "0x1")
	pool := NewPool(11155111, []Upstream{{Name: "mainnet-typo", URL: mainnet.URL}, {Name: "alchemy", URL: sepolia.URL}}, nil)

	pool.checkHealthOnce(context.Background())

	wrong, right := pool.providers[0], pool.providers[1]
	if !wrong.WrongChain() || wrong.Healthy() {
		t.Fatal("expected the Mainnet upstream to be disabled for a Sepolia pool")
	}
	if right.WrongChain() || !right.Healthy() {
		t.Fatal("expected the Sepolia upstream to stay healthy")
	}
	got := pool.candidates()
	if len(got) != 1 || got[0] != right {
		t.Fatalf("expected only the Sepolia upstream as a candidate, got %d", len(got))
	}
}

func TestCandidatesNeverFallBackToWrongChainUpstream(t *testing.T) {
	mainnet := chainUpstream(t, "0x1")
	pool := NewPool(11155111, []Upstream{{Name: "mainnet-typo", URL: mainnet.URL}}, nil)

	pool.checkHealthOnce(context.Background())

	if got := pool.candidates(); len(got) != 0 {
		t.Fatalf("expected no candidates when the only upstream serves another chain, got %d", len(got))
	}
}
