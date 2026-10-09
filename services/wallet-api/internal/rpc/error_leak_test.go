package rpc_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/rpc"
)

// TestUpstreamSecretNeverLeaksToClientOrLogs simulates a provider whose
// configured URL embeds an API key and which times out. Neither the JSON-RPC
// error returned to the client nor anything written to the logger may
// contain the secret or any part of the upstream URL.
func TestUpstreamSecretNeverLeaksToClientOrLogs(t *testing.T) {
	block := make(chan struct{})
	slowUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block // never respond until the test explicitly unblocks it
	}))

	secretURL := slowUpstream.URL + "/v2/SECRETKEY"

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	registry := evm.NewRegistry(map[int64]int{31337: 1})
	pool := rpc.NewPool(31337, []rpc.Upstream{{Name: "primary", URL: secretURL}}, logger)
	mgr := rpc.NewManager(registry, map[int64]*rpc.Pool{31337: pool})
	handler := rpc.NewHandler(mgr)

	r := chi.NewRouter()
	r.Post("/v1/rpc/evm/{chainId}", handler.ServeHTTP)
	srv := httptest.NewServer(r)
	defer srv.Close()

	start := time.Now()
	resp, err := http.Post(srv.URL+"/v1/rpc/evm/31337", "application/json",
		bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := new(bytes.Buffer)
	body.ReadFrom(resp.Body)
	elapsed := time.Since(start)
	t.Logf("request took %s", elapsed)
	close(block) // let the stuck upstream handler return so Close() doesn't hang
	slowUpstream.Close()

	if strings.Contains(body.String(), "SECRETKEY") {
		t.Fatalf("response body leaked the secret: %s", body.String())
	}
	if strings.Contains(body.String(), slowUpstream.URL) {
		t.Fatalf("response body leaked the upstream URL: %s", body.String())
	}

	var decoded map[string]any
	if err := json.Unmarshal(body.Bytes(), &decoded); err != nil {
		t.Fatalf("expected valid JSON-RPC response, got %s (%v)", body.String(), err)
	}
	errObj, ok := decoded["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected a JSON-RPC error, got %s", body.String())
	}
	if int(errObj["code"].(float64)) != -32603 {
		t.Fatalf("expected -32603, got %v", errObj["code"])
	}
	if msg, _ := errObj["message"].(string); msg != "upstream unavailable" {
		t.Fatalf("expected a generic error message, got %q", msg)
	}

	if strings.Contains(logBuf.String(), "SECRETKEY") {
		t.Fatalf("logs leaked the secret: %s", logBuf.String())
	}
	if strings.Contains(logBuf.String(), slowUpstream.URL) {
		t.Fatalf("logs leaked the upstream URL: %s", logBuf.String())
	}
	// Sanity: the log line should still be useful (provider name + cause).
	if !strings.Contains(logBuf.String(), "primary") {
		t.Fatalf("expected the provider name to still be logged, got: %s", logBuf.String())
	}
}
