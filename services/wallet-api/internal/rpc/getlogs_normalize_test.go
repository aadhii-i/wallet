package rpc_test

import (
	"encoding/json"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/rpc"
	"net/http"
	"net/http/httptest"
)

// TestGetLogsForwardsNormalizedFilterNotRawParams guards against a
// duplicate/case-variant-key desync: if the client's raw JSON contains both
// "fromBlock" and a differently-cased "FromBlock" with a much wider range,
// our validation (which follows Go's exact-key-match-first decoding) must
// still only ever let the upstream see the single, validated interpretation
// -- never the attacker-controlled duplicate key.
func TestGetLogsForwardsNormalizedFilterNotRawParams(t *testing.T) {
	var seenParams string
	up := newFakeUpstream(t, func(method string, params json.RawMessage) (any, *fakeErr) {
		seenParams = string(params)
		return []any{}, nil
	})
	registry := evm.NewRegistry(map[int64]int{31337: 1})
	pool := rpc.NewPool(31337, []rpc.Upstream{{Name: "only", URL: up.srv.URL}}, nil)
	mgr := rpc.NewManager(registry, map[int64]*rpc.Pool{31337: pool})
	handler := rpc.NewHandler(mgr)

	router := chi.NewRouter()
	router.Post("/v1/rpc/evm/{chainId}", handler.ServeHTTP)
	srv := httptest.NewServer(router)
	defer srv.Close()

	// A validated small range (0x0-0x64) alongside a duplicate, differently
	// cased key carrying a huge range that must never reach the upstream.
	body := `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x64","FromBlock":"0x0","ToBlock":"0xFFFFFF","address":"0xabc"}]}`
	resp, err := http.Post(srv.URL+"/v1/rpc/evm/31337", "application/json", jsonBodyReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if seenParams == "" {
		t.Fatal("expected the upstream to be called")
	}
	if !containsAll(seenParams, `"fromBlock":"0x0"`, `"toBlock":"0x64"`) {
		t.Fatalf("expected the upstream to see the validated range, got: %s", seenParams)
	}
	if containsAny(seenParams, "FromBlock", "ToBlock", "0xffffff", "0xFFFFFF") {
		t.Fatalf("expected the duplicate/case-variant wide-range keys to be dropped, got: %s", seenParams)
	}
	// The opaque address field must still be forwarded.
	if !containsAll(seenParams, `"address":"0xabc"`) {
		t.Fatalf("expected the address field to survive normalization, got: %s", seenParams)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !contains(s, sub) {
			return false
		}
	}
	return true
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if contains(s, sub) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func jsonBodyReader(s string) *stringReadCloser { return &stringReadCloser{s: s} }

type stringReadCloser struct {
	s   string
	pos int
}

func (r *stringReadCloser) Read(p []byte) (int, error) {
	if r.pos >= len(r.s) {
		return 0, ioEOF
	}
	n := copy(p, r.s[r.pos:])
	r.pos += n
	return n, nil
}
