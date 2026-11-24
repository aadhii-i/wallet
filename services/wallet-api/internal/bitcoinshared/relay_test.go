package bitcoinshared

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/db"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

func TestDeviceBoundRelay(t *testing.T) {
	ctx := context.Background()
	st := memory.New()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	epoch := uuid.New()
	wallet := &store.SharedWallet{ID: uuid.New(), MembershipVersion: 3, KeyStatus: store.KeyActive, KeyGenerationID: &epoch}
	member := &store.SharedMember{ID: uuid.New(), WalletID: wallet.ID, UserID: uuid.New(), DeviceID: uuid.New(), DevicePublicKey: public, Status: store.MemberActive}
	if err = st.SharedWallets().CreateWallet(ctx, wallet, member); err != nil {
		t.Fatal(err)
	}
	account := &store.SharedAccount{ID: uuid.New(), WalletID: wallet.ID, Name: "Research", DerivationIndex: 0}
	if err = st.SharedWallets().CreateAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	relay, err := New(st, nil, filepath.Join(t.TempDir(), "relay.json"))
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	relay.Routes(router)
	q := request{KeygenID: epoch.String(), MembershipVersion: 3, Kind: "enrollment", Session: "enrollment", Payload: base64.RawURLEncoding.EncodeToString([]byte(`{"public":"data"}`))}
	sign := func(q request) request {
		digest := sha256.Sum256([]byte(signingText(wallet.ID.String(), account.ID.String(), q)))
		r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		raw := make([]byte, 64)
		r.FillBytes(raw[:32])
		s.FillBytes(raw[32:])
		q.Signature = base64.RawURLEncoding.EncodeToString(raw)
		return q
	}
	call := func(q request, p *auth.Principal, acct uuid.UUID) int {
		body, _ := json.Marshal(q)
		req := httptest.NewRequest(http.MethodPost, "/v1/shared-wallets/"+wallet.ID.String()+"/bitcoin/"+acct.String(), bytes.NewReader(body))
		if p != nil {
			req = req.WithContext(auth.WithPrincipal(req.Context(), p))
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w.Code
	}
	principal := &auth.Principal{UserID: member.UserID, DeviceID: member.DeviceID}
	valid := sign(q)
	if code := call(valid, principal, account.ID); code != 200 {
		t.Fatalf("valid: %d", code)
	}
	if code := call(valid, principal, account.ID); code != 200 {
		t.Fatalf("retry: %d", code)
	}
	changed := valid
	changed.Payload += "A"
	if code := call(changed, principal, account.ID); code != 403 {
		t.Fatalf("payload signature: %d", code)
	}
	stale := q
	stale.MembershipVersion = 2
	if code := call(sign(stale), principal, account.ID); code != 409 {
		t.Fatalf("stale epoch: %d", code)
	}
	if code := call(valid, nil, account.ID); code != 404 {
		t.Fatalf("anonymous: %d", code)
	}
	for _, p := range []*auth.Principal{{UserID: uuid.New(), DeviceID: member.DeviceID}, {UserID: member.UserID, DeviceID: uuid.New()}} {
		if code := call(valid, p, account.ID); code != 404 {
			t.Fatalf("foreign identity/device: %d", code)
		}
	}
	if code := call(valid, principal, uuid.New()); code != 404 {
		t.Fatalf("foreign account: %d", code)
	}
	other := q
	other.Payload = base64.RawURLEncoding.EncodeToString([]byte(`{"different":true}`))
	if code := call(sign(other), principal, account.ID); code != 409 {
		t.Fatalf("overwrite: %d", code)
	}
	restarted, err := New(st, nil, relay.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.messages) != 1 {
		t.Fatal("signed public messages lost on restart")
	}
}

func TestImmutableConcurrentProposal(t *testing.T) {
	relay, _ := New(nil, nil, "")
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := uuid.NewString()
			if relay.append(context.Background(), "scope", Message{ID: id, From: id, Kind: "proposal", Session: "one", CreatedAt: time.Now()}) == nil {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("%d competing proposals accepted", winners.Load())
	}
}

func TestPostgresConcurrentRelay(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("disposable Postgres is required")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	relay, _ := New(nil, pool, "")
	scope := uuid.NewString()
	defer pool.Exec(ctx, "DELETE FROM bitcoin_shared_messages WHERE scope=$1", scope)
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := uuid.NewString()
			m := Message{ID: id, From: id, Kind: "proposal", Session: "one", Payload: "public", CreatedAt: time.Now()}
			if relay.append(ctx, scope, m) == nil {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("accepted %d competing proposals", winners.Load())
	}
	entries, err := relay.read(ctx, scope, "one")
	if err != nil || len(entries) != 1 {
		t.Fatalf("read persisted public messages: %v", err)
	}
	if err = relay.append(ctx, scope, entries[0]); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
}
