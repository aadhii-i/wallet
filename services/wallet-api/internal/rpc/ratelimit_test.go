package rpc

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// upstream answers JSON-RPC calls; reply(n, method) decides the status
// (0 = 200 with result "0x1") for the n-th call (1-based).
func upstream(t *testing.T, reply func(n int64, method string) int) (*httptest.Server, *atomic.Int64, *sync.Map) {
	t.Helper()
	var n atomic.Int64
	methods := &sync.Map{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req rpcEnvelope
		_ = json.Unmarshal(body, &req)
		c := n.Add(1)
		v, _ := methods.LoadOrStore(req.Method, new(atomic.Int64))
		v.(*atomic.Int64).Add(1)
		if code := reply(c, req.Method); code != 0 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(code)
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &n, methods
}

func TestForegroundReadRetriesAfter429(t *testing.T) {
	srv, n, _ := upstream(t, func(c int64, _ string) int {
		if c <= 2 {
			return http.StatusTooManyRequests
		}
		return 0
	})
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	out, err := p.Call(context.Background(), "eth_getBalance", []any{"0x0000000000000000000000000000000000000001", "latest"})
	if err != nil {
		t.Fatalf("want success after retries, got %v", err)
	}
	if string(out) != `"0x1"` || n.Load() != 3 {
		t.Fatalf("result %s after %d calls; want \"0x1\" after 3", out, n.Load())
	}
}

func TestForegroundRetriesAreBounded(t *testing.T) {
	srv, n, _ := upstream(t, func(int64, string) int { return http.StatusTooManyRequests })
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	_, err := p.Call(context.Background(), "eth_getBalance", []any{"0x0000000000000000000000000000000000000001", "latest"})
	if !IsRateLimited(err) || !strings.Contains(err.Error(), "HTTP 429") {
		t.Fatalf("want a 429 error, got %v", err)
	}
	if n.Load() != foregroundTries {
		t.Fatalf("%d upstream calls; want %d", n.Load(), foregroundTries)
	}
}

// A broadcast whose outcome is unknown must never be repeated automatically.
func TestSendRawTransactionIsNeverRetried(t *testing.T) {
	srv, n, _ := upstream(t, func(int64, string) int { return http.StatusTooManyRequests })
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	if _, err := p.Call(context.Background(), "eth_sendRawTransaction", []any{"0x02"}); err == nil {
		t.Fatal("want an error")
	}
	if n.Load() != 1 {
		t.Fatalf("eth_sendRawTransaction sent %d times; want 1", n.Load())
	}
}

func TestConcurrentIdenticalReadsShareOneCall(t *testing.T) {
	release := make(chan struct{})
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		<-release
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x5"}`))
	}))
	defer srv.Close()
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	var wg sync.WaitGroup
	errs := make(chan error, 10)
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := p.Call(context.Background(), "eth_getTransactionCount", []any{"0x0000000000000000000000000000000000000001", "pending"})
			if err == nil && string(out) != `"0x5"` {
				err = io.ErrUnexpectedEOF
			}
			errs <- err
		}()
	}
	time.Sleep(200 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("%d upstream calls for 10 identical concurrent reads; want 1", n.Load())
	}
	// Not cached afterwards (only chain id, head and fee reads are).
	if _, err := p.Call(context.Background(), "eth_getTransactionCount", []any{"0x0000000000000000000000000000000000000001", "pending"}); err != nil || n.Load() != 2 {
		t.Fatalf("a later read must reach the provider: %v, %d calls", err, n.Load())
	}
}

func TestChainIDIsCached(t *testing.T) {
	srv, n, _ := upstream(t, func(int64, string) int { return 0 })
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	for range 5 {
		if _, err := p.Call(context.Background(), "eth_chainId", []any{}); err != nil {
			t.Fatal(err)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("%d eth_chainId calls; want 1", n.Load())
	}
}

// After a 429, background work holds off the provider for the cooldown,
// while a foreground read fails over to the fallback provider at once.
func TestCooldownHoldsBackgroundAndPrefersFallback(t *testing.T) {
	primary, pn, _ := upstream(t, func(c int64, _ string) int {
		if c == 1 {
			return http.StatusTooManyRequests
		}
		return 0
	})
	fallback, fn, _ := upstream(t, func(int64, string) int { return 0 })
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: primary.URL}, {Name: "public", URL: fallback.URL}}, nil)
	addr := []any{"0x0000000000000000000000000000000000000001", "latest"}

	// First foreground read: primary 429s, the same call fails over.
	if _, err := p.Call(context.Background(), "eth_getBalance", addr); err != nil {
		t.Fatal(err)
	}
	if pn.Load() != 1 || fn.Load() != 1 {
		t.Fatalf("primary %d, fallback %d calls; want 1, 1", pn.Load(), fn.Load())
	}
	// While primary cools down, foreground reads go to the fallback first.
	if _, err := p.Call(context.Background(), "eth_getCode", addr); err != nil {
		t.Fatal(err)
	}
	if pn.Load() != 1 || fn.Load() != 2 {
		t.Fatalf("primary %d, fallback %d calls; want 1, 2", pn.Load(), fn.Load())
	}

	// A single-provider pool: background calls wait out the cooldown.
	only, on, _ := upstream(t, func(c int64, _ string) int {
		if c == 1 {
			return http.StatusTooManyRequests
		}
		return 0
	})
	q := NewPool(11155111, []Upstream{{Name: "alchemy", URL: only.URL}}, nil)
	bg := Background(context.Background())
	if _, err := q.Call(bg, "eth_getLogs", []any{map[string]string{"fromBlock": "0x1", "toBlock": "0x1"}}); !IsRateLimited(err) {
		t.Fatalf("background 429 is returned to the caller's own retry loop, got %v", err)
	}
	ctx, cancel := context.WithTimeout(bg, cooldownMin/2)
	defer cancel()
	if _, err := q.Call(ctx, "eth_getLogs", []any{map[string]string{"fromBlock": "0x2", "toBlock": "0x2"}}); err == nil {
		t.Fatal("background call went through during the cooldown")
	}
	if on.Load() != 1 {
		t.Fatalf("provider called %d times during its cooldown; want 1", on.Load())
	}
	start := time.Now()
	if _, err := q.Call(bg, "eth_getLogs", []any{map[string]string{"fromBlock": "0x3", "toBlock": "0x3"}}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < cooldownMin/3 {
		t.Fatal("background call did not wait for the cooldown")
	}
}

func TestBackgroundRateLimit(t *testing.T) {
	srv, n, _ := upstream(t, func(int64, string) int { return 0 })
	p := NewPool(11155111, []Upstream{{Name: "alchemy", URL: srv.URL}}, nil)
	p.SetBackgroundRate(5)
	bg := Background(context.Background())
	start := time.Now()
	for i := range 10 {
		if _, err := p.Call(bg, "eth_getBalance", []any{"0x0000000000000000000000000000000000000001", i}); err != nil {
			t.Fatal(err)
		}
	}
	// burst 5, then 5 more at 5/s: at least ~1s.
	if el := time.Since(start); el < 900*time.Millisecond {
		t.Fatalf("10 background calls took %s; want >= ~1s at 5/s", el)
	}
	// Foreground calls are not paced by the background lane.
	start = time.Now()
	for i := range 10 {
		if _, err := p.Call(context.Background(), "eth_getBalance", []any{"0x0000000000000000000000000000000000000002", i}); err != nil {
			t.Fatal(err)
		}
	}
	if el := time.Since(start); el > 500*time.Millisecond {
		t.Fatalf("foreground calls were paced: %s", el)
	}
	if n.Load() != 20 {
		t.Fatalf("%d calls; want 20", n.Load())
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		h    string
		want time.Duration
	}{
		{"", 0}, {"3", 3 * time.Second}, {"-1", 0}, {"999", retryAfterMax}, {"nonsense", 0},
		{now.Add(5 * time.Second).Format(http.TimeFormat), 5 * time.Second},
	} {
		if got := parseRetryAfter(c.h, now); got != c.want {
			t.Errorf("Retry-After %q: %s, want %s", c.h, got, c.want)
		}
	}
}
