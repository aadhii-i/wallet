package auth_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

func sha256sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

type jsonReader = bytes.Reader

func newJSONReader(t *testing.T, v any) *jsonReader {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(b)
}

const testOrigin = "http://localhost:3000"

type testEnv struct {
	t       *testing.T
	server  *httptest.Server
	st      store.Store
	svc     *auth.Service
	csrfKey []byte
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	km, err := security.NewLocalDevKeyManager(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	st := memory.New()
	svc := auth.NewService(st, km)
	csrfKey := []byte("test-csrf-key")
	ipHashKey := []byte("test-ip-hash-key")
	h := auth.NewHandlers(svc, []string{testOrigin}, false, auth.CookieNames{Access: "qd_at", Refresh: "qd_rt"}, csrfKey, ipHashKey, nil)

	r := chi.NewRouter()
	r.Post("/v1/auth/challenge", h.CreateChallenge)
	r.Post("/v1/auth/register", h.Register)
	r.Post("/v1/auth/login", h.Login)
	r.Post("/v1/auth/refresh", h.Refresh)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(svc, auth.CookieNames{Access: "qd_at", Refresh: "qd_rt"}, csrfKey))
		r.Get("/v1/me", h.Me)
		r.Post("/v1/auth/logout", h.Logout)
		r.Get("/v1/devices", h.ListDevices)
		r.Patch("/v1/devices/{deviceId}", h.RenameDevice)
		r.Delete("/v1/devices/{deviceId}", h.RevokeDevice)
	})

	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &testEnv{t: t, server: srv, st: st, svc: svc, csrfKey: csrfKey}
}

type testDevice struct {
	priv *ecdsa.PrivateKey
	pub  string // base64url SPKI DER
}

func newTestDevice(t *testing.T) *testDevice {
	t.Helper()
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := auth.SPKIDER(&pk.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return &testDevice{priv: pk, pub: base64.RawURLEncoding.EncodeToString(der)}
}

func (d *testDevice) sign(t *testing.T, message string) string {
	t.Helper()
	digest := sha256sum([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, d.priv, digest)
	if err != nil {
		t.Fatal(err)
	}
	sig := auth.EncodeP1363Signature(elliptic.P256(), r, s)
	return base64.RawURLEncoding.EncodeToString(sig)
}

func doJSON(t *testing.T, client *http.Client, method, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	var reader *jsonReader
	if body != nil {
		reader = newJSONReader(t, body)
	}
	var req *http.Request
	var err error
	if reader != nil {
		req, err = http.NewRequest(method, url, reader)
	} else {
		req, err = http.NewRequest(method, url, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&decoded)
	return resp, decoded
}
