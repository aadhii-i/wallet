package account_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/qdwallet/wallet-api/internal/account"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

const testOrigin = "http://localhost:3000"

type testUser struct {
	client *http.Client
	userID string
	csrf   string
}

func newServer(t *testing.T) (*httptest.Server, store.Store) {
	t.Helper()
	dir := t.TempDir()
	km, err := security.NewLocalDevKeyManager(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	st := memory.New()
	authSvc := auth.NewService(st, km)
	csrfKey := []byte("csrf-key")
	authH := auth.NewHandlers(authSvc, []string{testOrigin}, false, auth.CookieNames{Access: "qd_at", Refresh: "qd_rt"}, csrfKey, []byte("ip-key"), nil)
	acctSvc := account.NewService(st)
	acctH := account.NewHandlers(acctSvc, st)

	r := chi.NewRouter()
	r.Post("/v1/auth/challenge", authH.CreateChallenge)
	r.Post("/v1/auth/register", authH.Register)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(authSvc, auth.CookieNames{Access: "qd_at", Refresh: "qd_rt"}, csrfKey))
		r.Get("/v1/wallets", acctH.ListWallets)
		r.Post("/v1/wallets", acctH.CreateWallet)
		r.Post("/v1/wallets/{walletId}/accounts", acctH.CreateAccount)
		r.Patch("/v1/accounts/{accountId}", acctH.UpdateAccount)
		r.Put("/v1/accounts/{accountId}/addresses", acctH.RegisterAddress)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, st
}

func registerUser(t *testing.T, baseURL string) *testUser {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := auth.SPKIDER(&pk.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pub := base64.RawURLEncoding.EncodeToString(der)

	resp, body := postJSON(t, client, baseURL+"/v1/auth/challenge", map[string]any{"devicePublicKey": pub}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("challenge failed: %d", resp.StatusCode)
	}
	challengeID := body["challengeId"].(string)
	message := body["message"].(string)
	digest := sha256sum([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, pk, digest)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.RawURLEncoding.EncodeToString(auth.EncodeP1363Signature(elliptic.P256(), r, s))

	resp, regBody := postJSON(t, client, baseURL+"/v1/auth/register", map[string]any{
		"challengeId": challengeID, "signature": sig, "platform": "web",
	}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register failed: %d %v", resp.StatusCode, regBody)
	}
	return &testUser{client: client, userID: regBody["userId"].(string), csrf: regBody["csrfToken"].(string)}
}

func sha256sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func postJSON(t *testing.T, client *http.Client, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url, jsonBody(b))
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

func patchJSON(t *testing.T, client *http.Client, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPatch, url, jsonBody(b))
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

func putJSON(t *testing.T, client *http.Client, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPut, url, jsonBody(b))
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

func TestCreateWalletAndAccountAndRegisterAddress(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)

	resp, walletBody := postJSON(t, u.client, srv.URL+"/v1/wallets", map[string]any{"label": "My Wallet"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create wallet failed: %d %v", resp.StatusCode, walletBody)
	}
	walletID := walletBody["id"].(string)

	resp, accBody := postJSON(t, u.client, srv.URL+"/v1/wallets/"+walletID+"/accounts", map[string]any{"hdIndex": 0, "name": "Account 1"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create account failed: %d %v", resp.StatusCode, accBody)
	}
	accountID := accBody["id"].(string)

	pk, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	message := account.AddressRegistrationMessage(accountID, address, u.userID)
	hash := crypto.Keccak256([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(message)) + message))
	sig, err := crypto.Sign(hash, pk)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	proof := "0x" + hex.EncodeToString(sig)

	resp, addrBody := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "evm", "address": address, "proof": proof,
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register address failed: %d %v", resp.StatusCode, addrBody)
	}
}

func TestIDORCrossUserAccountAccess(t *testing.T) {
	srv, _ := newServer(t)
	userA := registerUser(t, srv.URL)
	userB := registerUser(t, srv.URL)

	resp, walletBody := postJSON(t, userA.client, srv.URL+"/v1/wallets", map[string]any{"label": "A's wallet"}, map[string]string{"X-CSRF-Token": userA.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create wallet failed: %d", resp.StatusCode)
	}
	walletID := walletBody["id"].(string)
	resp, accBody := postJSON(t, userA.client, srv.URL+"/v1/wallets/"+walletID+"/accounts", map[string]any{"hdIndex": 0, "name": "A1"}, map[string]string{"X-CSRF-Token": userA.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create account failed: %d", resp.StatusCode)
	}
	accountID := accBody["id"].(string)

	// User B must not be able to read/modify user A's wallet or account.
	resp, _ = postJSON(t, userB.client, srv.URL+"/v1/wallets/"+walletID+"/accounts", map[string]any{"hdIndex": 1, "name": "hijack"}, map[string]string{"X-CSRF-Token": userB.csrf})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user wallet access, got %d", resp.StatusCode)
	}

	resp, _ = patchJSON(t, userB.client, srv.URL+"/v1/accounts/"+accountID, map[string]any{"name": "hijacked"}, map[string]string{"X-CSRF-Token": userB.csrf})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user account update, got %d", resp.StatusCode)
	}
}

func TestCreateWalletIdempotency(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)

	key := uuid.NewString()
	req1, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/wallets", jsonBody([]byte(`{"label":"Once"}`)))
	if err != nil {
		t.Fatal(err)
	}
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("Idempotency-Key", key)
	req1.Header.Set("X-CSRF-Token", u.csrf)
	resp1, err := u.client.Do(req1)
	if err != nil {
		t.Fatal(err)
	}
	var body1 map[string]any
	_ = json.NewDecoder(resp1.Body).Decode(&body1)
	resp1.Body.Close()

	req2, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/wallets", jsonBody([]byte(`{"label":"Once"}`)))
	if err != nil {
		t.Fatal(err)
	}
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Idempotency-Key", key)
	req2.Header.Set("X-CSRF-Token", u.csrf)
	resp2, err := u.client.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	var body2 map[string]any
	_ = json.NewDecoder(resp2.Body).Decode(&body2)
	resp2.Body.Close()

	if body1["id"] != body2["id"] {
		t.Fatalf("expected idempotent create to return the same wallet id, got %v vs %v", body1["id"], body2["id"])
	}
}

func jsonBody(b []byte) *bytes.Reader { return bytes.NewReader(b) }
