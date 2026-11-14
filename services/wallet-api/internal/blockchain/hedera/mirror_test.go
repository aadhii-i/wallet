package hedera

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
