package transaction

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

type stubProvider struct {
	items []evm.ActivityItem
	err   error
}

func (s stubProvider) FetchActivity(context.Context, string, []string) ([]evm.ActivityItem, error) {
	return s.items, s.err
}

type stubProviders struct{ p evm.HistoryProvider }

func (s stubProviders) ProviderFor(string) evm.HistoryProvider { return s.p }

// activityResponse calls GetActivity for a fresh user with one registered EVM
// address, with the given history provider and request context.
func activityResponse(t *testing.T, ctx context.Context, p evm.HistoryProvider) (int, map[string]json.RawMessage) {
	t.Helper()
	st := memory.New()
	now := time.Now()
	user := &store.User{ID: uuid.New(), Status: store.UserActive, CreatedAt: now}
	wallet := &store.Wallet{ID: uuid.New(), UserID: user.ID, Label: "w", CreatedAt: now}
	account := &store.Account{ID: uuid.New(), WalletID: wallet.ID, UserID: user.ID, Name: "a", CreatedAt: now}
	addr := &store.Address{ID: uuid.New(), AccountID: account.ID, NetworkFamily: "evm", Address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", CreatedAt: now}
	for _, err := range []error{
		st.Users().Create(ctx, user), st.Wallets().Create(ctx, wallet), st.Accounts().Create(ctx, account), st.Addresses().Create(ctx, addr),
	} {
		if err != nil {
			t.Fatalf("seed store: %v", err)
		}
	}

	h := NewActivityHandlers(st, stubProviders{p})
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("accountId", account.ID.String())
	ctx = context.WithValue(auth.WithPrincipal(ctx, &auth.Principal{UserID: user.ID}), chi.RouteCtxKey, rctx)
	req := httptest.NewRequest(http.MethodGet, "/v1/accounts/"+account.ID.String()+"/activity?network=sepolia", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.GetActivity(rec, req)

	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return rec.Code, body
}

// A failing history provider (e.g. Alchemy answering 429 once its monthly
// quota is used up) used to produce 200 {"items":[]}, indistinguishable from
// an account with no history.
func TestActivityReportsAFailedHistoryProvider(t *testing.T) {
	code, body := activityResponse(t, context.Background(), stubProvider{err: errors.New("rpc error 429: Monthly capacity limit exceeded")})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (tracked and indexed items are still served)", code)
	}
	if got := string(body["historyUnavailable"]); got != "true" {
		t.Fatalf("historyUnavailable = %q, want true; body %v", got, body)
	}
	if got := string(body["items"]); got != "[]" {
		t.Fatalf("items = %s, want []", got)
	}
}

func TestActivityFromAWorkingProviderIsNotFlagged(t *testing.T) {
	items := []evm.ActivityItem{{
		Hash: "0xaaa", NetworkID: "sepolia", Direction: "in", From: "0xother", To: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
		Amount: "0x1", Timestamp: time.Now().Unix(),
	}}
	code, body := activityResponse(t, context.Background(), stubProvider{items: items})
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if _, ok := body["historyUnavailable"]; ok {
		t.Fatalf("historyUnavailable present for a working provider: %v", body)
	}
	var got []map[string]any
	if err := json.Unmarshal(body["items"], &got); err != nil || len(got) != 1 || got[0]["hash"] != "0xaaa" {
		t.Fatalf("items = %s (err %v), want the provider's one item", body["items"], err)
	}
}

// A client that went away (e.g. the app switched accounts) is not a provider
// failure and is not reported as one.
func TestActivityIgnoresProviderErrorsFromACancelledRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, body := activityResponse(t, ctx, stubProvider{err: context.Canceled})
	if _, ok := body["historyUnavailable"]; ok {
		t.Fatalf("historyUnavailable set for a cancelled request: %v", body)
	}
}
