package btc

// fakeEsplora is a lightweight in-process HTTP test server that responds to
// Esplora REST endpoints.  Tests register per-path handlers; unregistered
// paths return 404.  It replaces the former fakeCore JSON-RPC server.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type fakeEsploraHandler func(w http.ResponseWriter, r *http.Request)

type fakeEsplora struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	handlers map[string]fakeEsploraHandler
	calls    map[string]int
}

func newFakeEsplora(t *testing.T) *fakeEsplora {
	t.Helper()
	f := &fakeEsplora{
		t:        t,
		handlers: make(map[string]fakeEsploraHandler),
		calls:    make(map[string]int),
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls[r.URL.Path]++
		h, ok := f.handlers[r.URL.Path]
		f.mu.Unlock()
		if !ok {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		h(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// on registers a handler for a specific path (e.g. "/blocks/tip/height").
func (f *fakeEsplora) on(path string, h fakeEsploraHandler) {
	f.mu.Lock()
	f.handlers[path] = h
	f.mu.Unlock()
}

// onJSON registers a handler that writes v as JSON with status 200.
func (f *fakeEsplora) onJSON(path string, v any) {
	f.on(path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	})
}

// onText registers a handler that writes a plain text response.
func (f *fakeEsplora) onText(path, body string) {
	f.on(path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(body))
	})
}

// called returns the number of times path was requested.
func (f *fakeEsplora) called(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[path]
}

// client builds an Esplora client pointed at the fake server.
func (f *fakeEsplora) client() *Esplora {
	return NewEsplora(EsploraConfig{BaseURL: f.srv.URL})
}

// service builds a Service wired to the fake server with the given network.
func (f *fakeEsplora) service(network Network, floor, max int64) *Service {
	f.t.Helper()
	return NewService(f.client(), network, floor, max, nil)
}

// --- helpers used in multiple test files ---

// stdFakeEsplora wires the standard endpoints a typical test needs and
// returns the fake server + a mainnet service.
func stdFakeEsplora(t *testing.T) (*fakeEsplora, *Service) {
	t.Helper()
	f := newFakeEsplora(t)
	f.onText("/blocks/tip/height", "800000")
	f.onJSON("/fee-estimates", map[string]float64{
		"1": 50, "6": 12, "1008": 1,
	})
	return f, f.service(NetworkMainnet, 1, 500)
}

// readBody reads and returns the full request body as a string.
func readBody(r *http.Request) string {
	b, _ := io.ReadAll(r.Body)
	return strings.TrimSpace(string(b))
}
