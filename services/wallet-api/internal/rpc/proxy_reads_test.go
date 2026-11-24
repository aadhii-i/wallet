package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"golang.org/x/time/rate"
)

func proxyReadHandler(pool *Pool) http.Handler {
	registry := evm.NewRegistry(map[int64]int{31337: 1})
	handler := NewHandler(NewManager(registry, map[int64]*Pool{31337: pool}))
	router := chi.NewRouter()
	router.Post("/v1/rpc/evm/{chainId}", handler.ServeHTTP)
	return router
}

func readProxyResponse(handler http.Handler, id int) (rpcEnvelope, error) {
	body, err := json.Marshal(rpcEnvelope{
		JSONRPC: "2.0", ID: json.RawMessage(fmt.Sprint(id)),
		Method: "eth_blockNumber", Params: json.RawMessage("[]"),
	})
	if err != nil {
		return rpcEnvelope{}, err
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/rpc/evm/31337", bytes.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var out rpcEnvelope
	err = json.Unmarshal(response.Body.Bytes(), &out)
	return out, err
}

func TestProxyReadRetriesTemporary429(t *testing.T) {
	server, calls, _ := upstream(t, func(count int64, _ string) int {
		if count == 1 {
			return http.StatusTooManyRequests
		}
		return 0
	})
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	out, err := readProxyResponse(proxyReadHandler(pool), 17)
	if err != nil || out.Error != nil || string(out.Result) != `"0x1"` || string(out.ID) != "17" {
		t.Fatalf("response=%+v error=%v", out, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("upstream calls=%d, want 2", calls.Load())
	}
}

func TestProxyReadRetriesAreBounded(t *testing.T) {
	server, calls, _ := upstream(t, func(int64, string) int { return http.StatusTooManyRequests })
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	out, err := readProxyResponse(proxyReadHandler(pool), 18)
	if err != nil || out.Error == nil || out.Error.Message != "upstream unavailable" {
		t.Fatalf("response=%+v error=%v", out, err)
	}
	if calls.Load() != foregroundTries {
		t.Fatalf("upstream calls=%d, want %d", calls.Load(), foregroundTries)
	}
	if pool.providers[0].isOpen() {
		t.Fatal("temporary throttling opened the provider circuit")
	}
}

func TestProxyReadCachesBlockAndPreservesRequestIDs(t *testing.T) {
	server, calls, _ := upstream(t, func(int64, string) int { return 0 })
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	handler := proxyReadHandler(pool)
	for id := 1; id <= 5; id++ {
		out, err := readProxyResponse(handler, id)
		if err != nil || out.Error != nil || string(out.ID) != fmt.Sprint(id) {
			t.Fatalf("request %d: response=%+v error=%v", id, out, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream calls=%d, want 1", calls.Load())
	}
}

func TestProxyConcurrentReadsShareCall(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-release
		_ = json.NewEncoder(w).Encode(rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Result: json.RawMessage(`"0x1"`)})
	}))
	defer server.Close()
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	handler := proxyReadHandler(pool)
	errors := make(chan error, 8)
	var wait sync.WaitGroup
	for id := 1; id <= 8; id++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			out, err := readProxyResponse(handler, id)
			if err == nil && (out.Error != nil || string(out.ID) != fmt.Sprint(id)) {
				err = fmt.Errorf("request %d returned incorrect response: %+v", id, out)
			}
			errors <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream calls=%d, want 1", calls.Load())
	}
}

func TestProxyPreservesRPCErrorDataWithoutCachingErrors(t *testing.T) {
	var calls atomic.Int64
	data := json.RawMessage(`{"reason":"diagnostic"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Result: json.RawMessage(`"0x1"`)}
		if calls.Add(1) == 1 {
			out.Result = nil
			out.Error = &rpcError{Code: -32000, Message: "read rejected", Data: data}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer server.Close()
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	handler := proxyReadHandler(pool)
	out, err := readProxyResponse(handler, 31)
	if err != nil || out.Error == nil || out.Error.Code != -32000 || out.Error.Message != "read rejected" || !bytes.Equal(out.Error.Data, data) || string(out.ID) != "31" {
		t.Fatalf("upstream error was changed: response=%+v error=%v", out, err)
	}
	out, err = readProxyResponse(handler, 32)
	if err != nil || out.Error != nil || string(out.Result) != `"0x1"` || string(out.ID) != "32" || calls.Load() != 2 {
		t.Fatalf("error was cached or retried: response=%+v error=%v calls=%d", out, err, calls.Load())
	}
}

func TestProxyReadRecoversAfterLocalQuotaRefills(t *testing.T) {
	server, calls, _ := upstream(t, func(int64, string) int { return 0 })
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	provider := pool.providers[0]
	provider.limiter = rate.NewLimiter(50, 1)
	provider.limiter.Allow()
	out, err := readProxyResponse(proxyReadHandler(pool), 41)
	if err != nil || out.Error != nil || calls.Load() != 1 || provider.isOpen() {
		t.Fatalf("response=%+v error=%v upstream calls=%d", out, err, calls.Load())
	}
}

func TestLocalQuotaPreservesProviderCircuitAndHealth(t *testing.T) {
	server, calls, _ := upstream(t, func(int64, string) int { return 0 })
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	provider := pool.providers[0]
	provider.chainVerified = true
	provider.limiter = rate.NewLimiter(0, 1)
	provider.limiter.Allow()
	request := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "eth_blockNumber", Params: json.RawMessage("[]")}
	for range consecutiveFailuresToOpen {
		_, err := (&Handler{}).forwardReadOnce(context.Background(), pool, request)
		if !IsRateLimited(err) {
			t.Fatalf("expected typed quota error, got %v", err)
		}
	}
	pool.checkHealthOnce(context.Background())
	if calls.Load() != 0 || provider.isOpen() || !provider.Healthy() || provider.consecutiveFails != 0 {
		t.Fatalf("local throttling affected node health: calls=%d healthy=%v failures=%d", calls.Load(), provider.Healthy(), provider.consecutiveFails)
	}
}

func Test429HealthProbePreservesProviderHealth(t *testing.T) {
	server, _, _ := upstream(t, func(int64, string) int { return http.StatusTooManyRequests })
	pool := NewPool(31337, []Upstream{{Name: "test", URL: server.URL}}, nil)
	provider := pool.providers[0]
	provider.chainVerified = true
	for range consecutiveFailuresToOpen {
		pool.checkHealthOnce(context.Background())
	}
	if !provider.Healthy() || provider.consecutiveFails != 0 {
		t.Fatalf("429 probe affected node health: healthy=%v failures=%d", provider.Healthy(), provider.consecutiveFails)
	}
}
