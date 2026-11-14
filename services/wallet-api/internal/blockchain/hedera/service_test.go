package hedera

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// mockMirrorResponse builds a test HTTP server that returns the given JSON for any account request.
func mockMirrorResponse(t *testing.T, statusCode int, body string) *Mirror {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewMirror(MirrorConfig{BaseURL: srv.URL})
}

func TestGetAccountBalance_Conversions(t *testing.T) {
	cases := []struct {
		tinybars    int64
		wantDisplay string
	}{
		{100_000_000, "1.00000000 HBAR"},
		{1, "0.00000001 HBAR"},
		{0, "0.00000000 HBAR"},
		{123456789, "1.23456789 HBAR"},
	}

	for _, tc := range cases {
		body := fmt.Sprintf(`{"account":"0.0.1","balance":{"balance":%d},"key":{"_type":"ECDSA_SECP256K1","key":"aa"}}`, tc.tinybars)
		mirror := mockMirrorResponse(t, http.StatusOK, body)
		svc := NewService(mirror)
		bal, err := svc.GetAccountBalance(context.Background(), "0.0.1")
		if err != nil {
			t.Errorf("tinybars=%d: unexpected error: %v", tc.tinybars, err)
			continue
		}
		if bal.Tinybars != tc.tinybars {
			t.Errorf("tinybars=%d: Tinybars = %d, want %d", tc.tinybars, bal.Tinybars, tc.tinybars)
		}
		if bal.HbarDisplay != tc.wantDisplay {
			t.Errorf("tinybars=%d: HbarDisplay = %q, want %q", tc.tinybars, bal.HbarDisplay, tc.wantDisplay)
		}
	}
}

func TestVerifyAccountOwnership_Success(t *testing.T) {
	pubKey := "02aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"
	body := fmt.Sprintf(`{"account":"0.0.1","balance":{"balance":0},"key":{"_type":"ECDSA_SECP256K1","key":%q}}`, pubKey)
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	if err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", pubKey); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVerifyAccountOwnership_WrongKeyType(t *testing.T) {
	body := `{"account":"0.0.1","balance":{"balance":0},"key":{"_type":"ED25519","key":"aabb"}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "aabb")
	if !errors.Is(err, ErrKeyTypeMismatch) {
		t.Fatalf("want ErrKeyTypeMismatch, got %v", err)
	}
}

func TestVerifyAccountOwnership_KeyMismatch(t *testing.T) {
	body := `{"account":"0.0.1","balance":{"balance":0},"key":{"_type":"ECDSA_SECP256K1","key":"aabb"}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "ccdd")
	if !errors.Is(err, ErrPublicKeyMismatch) {
		t.Fatalf("want ErrPublicKeyMismatch, got %v", err)
	}
}

func TestVerifyAccountOwnership_AccountNotFound(t *testing.T) {
	mirror := mockMirrorResponse(t, http.StatusNotFound, `{}`)
	svc := NewService(mirror)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "aabb")
	if !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("want ErrAccountNotFound, got %v", err)
	}
}
