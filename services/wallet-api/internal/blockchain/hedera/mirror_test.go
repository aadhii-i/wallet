package hedera

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGetAccount_Success(t *testing.T) {
	body := `{
		"account": "0.0.12345",
		"balance": {"balance": 100000000},
		"key": {"_type": "ECDSA_SECP256K1", "key": "02aabbcc"}
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/accounts/0.0.12345" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	acct, err := m.GetAccount(context.Background(), "0.0.12345")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if acct.Account != "0.0.12345" {
		t.Errorf("Account = %q, want %q", acct.Account, "0.0.12345")
	}
	if acct.Balance.Balance != 100_000_000 {
		t.Errorf("Balance = %d, want %d", acct.Balance.Balance, 100_000_000)
	}
	if acct.Key.Type != "ECDSA_SECP256K1" {
		t.Errorf("Key.Type = %q, want ECDSA_SECP256K1", acct.Key.Type)
	}
	if acct.Key.Key != "02aabbcc" {
		t.Errorf("Key.Key = %q, want 02aabbcc", acct.Key.Key)
	}
}

func TestGetAccount_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetAccount(context.Background(), "0.0.99999")
	if !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("want ErrAccountNotFound, got %v", err)
	}
}

func TestGetAccount_MalformedID(t *testing.T) {
	// No HTTP call should be made for a malformed account id.
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetAccount(context.Background(), "not-an-id")
	if !errors.Is(err, ErrInvalidAccountID) {
		t.Fatalf("want ErrInvalidAccountID, got %v", err)
	}
	if called {
		t.Error("HTTP call was made for malformed account id")
	}
}

func TestGetAccount_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetAccount(context.Background(), "0.0.1")
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
	if errors.Is(err, ErrAccountNotFound) || errors.Is(err, ErrInvalidAccountID) {
		t.Errorf("unexpected sentinel error: %v", err)
	}
}

func TestGetAccount_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sleep longer than the client timeout; use a context-aware sleep.
		select {
		case <-time.After(30 * time.Second):
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := &Mirror{
		base:   srv.URL,
		client: &http.Client{Timeout: 10 * time.Millisecond},
	}
	_, err := m.GetAccount(context.Background(), "0.0.1")
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}

func TestGetTransactions_Success(t *testing.T) {
	body := `{
		"transactions": [
			{
				"transaction_id": "0.0.12345-1700000000-123456789",
				"name": "CRYPTOTRANSFER",
				"consensus_timestamp": "1700000000.123456789",
				"result": "SUCCESS",
				"charged_tx_fee": 1000000,
				"transfers": [
					{"account": "0.0.12345", "amount": -1001000000},
					{"account": "0.0.67890", "amount": 1000000000},
					{"account": "0.0.98", "amount": 1000000}
				]
			},
			{
				"transaction_id": "0.0.67890-1699999000-000000111",
				"name": "CRYPTOTRANSFER",
				"consensus_timestamp": "1699999000.000000111",
				"result": "SUCCESS",
				"charged_tx_fee": 500000,
				"transfers": [
					{"account": "0.0.67890", "amount": -200000000},
					{"account": "0.0.12345", "amount": 199500000},
					{"account": "0.0.98", "amount": 500000}
				]
			}
		],
		"links": {"next": null}
	}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transactions" {
			http.NotFound(w, r)
			return
		}
		if q := r.URL.Query(); q.Get("account.id") != "0.0.12345" || q.Get("type") != "CRYPTOTRANSFER" || q.Get("order") != "desc" || q.Get("limit") != "25" {
			t.Errorf("unexpected query: %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	page, err := m.GetTransactions(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Transactions) != 2 {
		t.Fatalf("Transactions len = %d, want 2", len(page.Transactions))
	}
	tx0 := page.Transactions[0]
	if tx0.TransactionID != "0.0.12345-1700000000-123456789" {
		t.Errorf("TransactionID = %q, want 0.0.12345-1700000000-123456789", tx0.TransactionID)
	}
	if tx0.Name != "CRYPTOTRANSFER" {
		t.Errorf("Name = %q, want CRYPTOTRANSFER", tx0.Name)
	}
	if tx0.ConsensusTimestamp != "1700000000.123456789" {
		t.Errorf("ConsensusTimestamp = %q, want 1700000000.123456789", tx0.ConsensusTimestamp)
	}
	if tx0.Result != "SUCCESS" {
		t.Errorf("Result = %q, want SUCCESS", tx0.Result)
	}
	if tx0.Charged_tx_fee != 1000000 {
		t.Errorf("Charged_tx_fee = %d, want 1000000", tx0.Charged_tx_fee)
	}
	if len(tx0.Transfers) != 3 {
		t.Fatalf("Transfers len = %d, want 3", len(tx0.Transfers))
	}
	// Direction/amount at the raw level: sender debit (negative leg) and
	// recipient credit (positive leg) must be preserved with their signs.
	if tx0.Transfers[0].Account != "0.0.12345" || tx0.Transfers[0].Amount != -1001000000 {
		t.Errorf("transfer[0] = {%s, %d}, want {0.0.12345, -1001000000}", tx0.Transfers[0].Account, tx0.Transfers[0].Amount)
	}
	if tx0.Transfers[1].Account != "0.0.67890" || tx0.Transfers[1].Amount != 1000000000 {
		t.Errorf("transfer[1] = {%s, %d}, want {0.0.67890, 1000000000}", tx0.Transfers[1].Account, tx0.Transfers[1].Amount)
	}
	// Second transaction: account 0.0.12345 appears on a positive (incoming) leg.
	tx1 := page.Transactions[1]
	if tx1.Transfers[1].Account != "0.0.12345" || tx1.Transfers[1].Amount != 199500000 {
		t.Errorf("tx1 transfer[1] = {%s, %d}, want {0.0.12345, 199500000}", tx1.Transfers[1].Account, tx1.Transfers[1].Amount)
	}
	if page.Links.Next != nil {
		t.Errorf("Links.Next = %v, want nil", page.Links.Next)
	}
}

func TestGetTransactions_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetTransactions(context.Background(), "0.0.99999", "")
	if !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("want ErrAccountNotFound, got %v", err)
	}
}

func TestGetTransactions_PaginationCursor(t *testing.T) {
	nextLink := "/api/v1/transactions?account.id=0.0.12345&limit=25&order=desc&type=CRYPTOTRANSFER&timestamp=lt:1699999000.000000111"
	body := `{"transactions": [], "links": {"next": "` + nextLink + `"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transactions" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	page, err := m.GetTransactions(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if page.Links.Next == nil {
		t.Fatal("Links.Next is nil, want non-nil")
	}
	if *page.Links.Next != nextLink {
		t.Errorf("Links.Next = %q, want %q", *page.Links.Next, nextLink)
	}
	if !strings.Contains(*page.Links.Next, "timestamp=lt:1699999000.000000111") {
		t.Errorf("Links.Next missing timestamp cursor: %q", *page.Links.Next)
	}
}

func TestGetTransactions_MalformedID(t *testing.T) {
	// No HTTP call should be made for a malformed account id.
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetTransactions(context.Background(), "not-an-id", "")
	if !errors.Is(err, ErrInvalidAccountID) {
		t.Fatalf("want ErrInvalidAccountID, got %v", err)
	}
	if called {
		t.Error("HTTP call was made for malformed account id")
	}
}

func TestGetTransactions_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	_, err := m.GetTransactions(context.Background(), "0.0.1", "")
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
	if errors.Is(err, ErrAccountNotFound) || errors.Is(err, ErrInvalidAccountID) {
		t.Errorf("unexpected sentinel error: %v", err)
	}
}

func TestGetTransactions_CursorInjection(t *testing.T) {
	// A cursor carrying '&'/'=' must not be able to rewrite the mirror-node
	// query parameters. url.QueryEscape encodes it as a single timestamp
	// value, so the server still sees limit=25/type=CRYPTOTRANSFER and the
	// raw cursor round-trips through the timestamp param unmodified.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transactions" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("limit") != "25" || q.Get("order") != "desc" || q.Get("type") != "CRYPTOTRANSFER" {
			t.Errorf("cursor injected query params: limit=%q order=%q type=%q", q.Get("limit"), q.Get("order"), q.Get("type"))
		}
		if got := q.Get("timestamp"); got != "lt:x&limit=1000" {
			t.Errorf("timestamp = %q, want lt:x&limit=1000", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"transactions":[],"links":{"next":null}}`))
	}))
	defer srv.Close()

	m := NewMirror(MirrorConfig{BaseURL: srv.URL})
	if _, err := m.GetTransactions(context.Background(), "0.0.12345", "x&limit=1000"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
