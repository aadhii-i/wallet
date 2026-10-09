package transaction_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/qdwallet/wallet-api/internal/account"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/transaction"
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
	txSvc := transaction.NewService(st)
	txH := transaction.NewHandlers(txSvc, st)

	r := chi.NewRouter()
	r.Post("/v1/auth/challenge", authH.CreateChallenge)
	r.Post("/v1/auth/register", authH.Register)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(authSvc, auth.CookieNames{Access: "qd_at", Refresh: "qd_rt"}, csrfKey))
		r.Post("/v1/wallets", acctH.CreateWallet)
		r.Post("/v1/wallets/{walletId}/accounts", acctH.CreateAccount)
		r.Post("/v1/transactions", txH.Create)
		r.Get("/v1/transactions/{transactionId}", txH.Get)
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

	resp, body := doJSON(t, client, http.MethodPost, baseURL+"/v1/auth/challenge", map[string]any{"devicePublicKey": pub}, map[string]string{"X-QD-Client": "web", "Origin": testOrigin})
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

	resp, regBody := doJSON(t, client, http.MethodPost, baseURL+"/v1/auth/register", map[string]any{
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

func doJSON(t *testing.T, client *http.Client, method, url string, body any, headers map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(b))
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

func createAccount(t *testing.T, srv *httptest.Server, st store.Store, u *testUser) string {
	t.Helper()
	resp, walletBody := doJSON(t, u.client, http.MethodPost, srv.URL+"/v1/wallets", map[string]any{"label": "W"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create wallet failed: %d %v", resp.StatusCode, walletBody)
	}
	walletID := walletBody["id"].(string)
	resp, accBody := doJSON(t, u.client, http.MethodPost, srv.URL+"/v1/wallets/"+walletID+"/accounts", map[string]any{"hdIndex": 0, "name": "A1"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create account failed: %d %v", resp.StatusCode, accBody)
	}
	accountID := accBody["id"].(string)

	// Register "0xfrom" directly (bypassing the EIP-191 proof flow, tested
	// separately in internal/account) so POST /v1/transactions' "from must
	// be a registered address" check passes in these tests.
	accUUID, err := uuid.Parse(accountID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Addresses().Create(context.Background(), &store.Address{
		ID: uuid.New(), AccountID: accUUID, NetworkFamily: store.FamilyEVM, Address: "0xfrom", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	return accountID
}

func TestIDORCannotReadOtherUsersTransaction(t *testing.T) {
	srv, st := newServer(t)
	userA := registerUser(t, srv.URL)
	userB := registerUser(t, srv.URL)

	accountID := createAccount(t, srv, st, userA)

	resp, txBody := doJSON(t, userA.client, http.MethodPost, srv.URL+"/v1/transactions", map[string]any{
		"networkId": "anvil", "hash": "0xaaaa", "accountId": accountID,
		"from": "0xfrom", "to": "0xto", "assetId": "anvil:native", "amount": "1",
	}, map[string]string{"X-CSRF-Token": userA.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create tx failed: %d %v", resp.StatusCode, txBody)
	}
	txID := txBody["id"].(string)

	// User B must not be able to read user A's transaction.
	resp, _ = doJSON(t, userB.client, http.MethodGet, srv.URL+"/v1/transactions/"+txID, nil, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user transaction access, got %d", resp.StatusCode)
	}

	// The owner can read it.
	resp, _ = doJSON(t, userA.client, http.MethodGet, srv.URL+"/v1/transactions/"+txID, nil, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected owner to read their own transaction, got %d", resp.StatusCode)
	}
}

func TestTransactionCreateIsIdempotentOnNetworkAndHash(t *testing.T) {
	srv, st := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, srv, st, u)

	body := map[string]any{
		"networkId": "anvil", "hash": "0xbbbb", "accountId": accountID,
		"from": "0xfrom", "to": "0xto", "assetId": "anvil:native", "amount": "1",
	}
	resp1, body1 := doJSON(t, u.client, http.MethodPost, srv.URL+"/v1/transactions", body, map[string]string{"X-CSRF-Token": u.csrf})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first create failed: %d", resp1.StatusCode)
	}
	resp2, body2 := doJSON(t, u.client, http.MethodPost, srv.URL+"/v1/transactions", body, map[string]string{"X-CSRF-Token": u.csrf})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("second create failed: %d", resp2.StatusCode)
	}
	if body1["id"] != body2["id"] {
		t.Fatalf("expected the same transaction id for the same (networkId,hash), got %v vs %v", body1["id"], body2["id"])
	}
}
