package hedera

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	svc := newServiceWithRetry(mirror, 1, 0)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "aabb")
	if !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("want ErrAccountNotFound, got %v", err)
	}
}

func TestVerifyAccountOwnership_RetriesWhileNotIndexed(t *testing.T) {
	pubKey := "02aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900"
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests < 3 {
			// A freshly created account can be missing from the Mirror Node.
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"account":"0.0.1","balance":{"balance":0},"key":{"_type":"ECDSA_SECP256K1","key":%q}}`, pubKey)
	}))
	defer srv.Close()

	svc := newServiceWithRetry(NewMirror(MirrorConfig{BaseURL: srv.URL}), 4, time.Millisecond)
	if err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", pubKey); err != nil {
		t.Fatalf("unexpected error after the account became visible: %v", err)
	}
	if requests != 3 {
		t.Errorf("mirror requests = %d, want 3 (two 404s then a success)", requests)
	}
}

func TestVerifyAccountOwnership_StopsAfterRetryBudget(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	svc := newServiceWithRetry(NewMirror(MirrorConfig{BaseURL: srv.URL}), 3, time.Millisecond)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "aabb")
	if !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("want ErrAccountNotFound after the retry budget, got %v", err)
	}
	if requests != 3 {
		t.Errorf("mirror requests = %d, want 3 (the configured bound)", requests)
	}
}

func TestVerifyAccountOwnership_DoesNotRetryKeyMismatch(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"account":"0.0.1","balance":{"balance":0},"key":{"_type":"ECDSA_SECP256K1","key":"aabb"}}`))
	}))
	defer srv.Close()

	svc := newServiceWithRetry(NewMirror(MirrorConfig{BaseURL: srv.URL}), 4, time.Millisecond)
	err := svc.VerifyAccountOwnership(context.Background(), "0.0.1", "ccdd")
	if !errors.Is(err, ErrPublicKeyMismatch) {
		t.Fatalf("want ErrPublicKeyMismatch, got %v", err)
	}
	if requests != 1 {
		t.Errorf("mirror requests = %d, want 1 (a definitive mismatch is not retried)", requests)
	}
}

func TestGetTransactionHistory_Incoming(t *testing.T) {
	body := `{"transactions":[{"transaction_id":"0.0.67890-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"SUCCESS","charged_tx_fee":1000000,"transfers":[{"account":"0.0.67890","amount":-1001000000},{"account":"0.0.12345","amount":1000000000},{"account":"0.0.98","amount":1000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("Items len = %d, want 1", len(page.Items))
	}
	it := page.Items[0]
	if it.Direction != "in" {
		t.Errorf("Direction = %q, want in", it.Direction)
	}
	if it.AmountTinybars != 1000000000 {
		t.Errorf("AmountTinybars = %d, want 1000000000", it.AmountTinybars)
	}
	if it.HbarDisplay != "10.00000000 HBAR" {
		t.Errorf("HbarDisplay = %q, want 10.00000000 HBAR", it.HbarDisplay)
	}
	if it.From != "0.0.67890" {
		t.Errorf("From = %q, want 0.0.67890", it.From)
	}
	if it.To != "0.0.12345" {
		t.Errorf("To = %q, want 0.0.12345", it.To)
	}
	if it.Status != "confirmed" {
		t.Errorf("Status = %q, want confirmed", it.Status)
	}
	if it.FeeTinybars != 1000000 {
		t.Errorf("FeeTinybars = %d, want 1000000", it.FeeTinybars)
	}
	if it.Type != "CRYPTOTRANSFER" {
		t.Errorf("Type = %q, want CRYPTOTRANSFER", it.Type)
	}
	if it.NetworkID != "hedera-testnet" {
		t.Errorf("NetworkID = %q, want hedera-testnet", it.NetworkID)
	}
	if page.NextCursor != nil {
		t.Errorf("NextCursor = %v, want nil", page.NextCursor)
	}
}

func TestGetTransactionHistory_Outgoing(t *testing.T) {
	body := `{"transactions":[{"transaction_id":"0.0.12345-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"SUCCESS","charged_tx_fee":1000000,"transfers":[{"account":"0.0.12345","amount":-1001000000},{"account":"0.0.67890","amount":1000000000},{"account":"0.0.98","amount":1000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	it := page.Items[0]
	if it.Direction != "out" {
		t.Errorf("Direction = %q, want out", it.Direction)
	}
	if it.AmountTinybars != 1001000000 {
		t.Errorf("AmountTinybars = %d, want 1001000000", it.AmountTinybars)
	}
	if it.HbarDisplay != "10.01000000 HBAR" {
		t.Errorf("HbarDisplay = %q, want 10.01000000 HBAR", it.HbarDisplay)
	}
	if it.From != "0.0.12345" {
		t.Errorf("From = %q, want 0.0.12345", it.From)
	}
	if it.To != "0.0.67890" {
		t.Errorf("To = %q, want 0.0.67890", it.To)
	}
}

func TestGetTransactionHistory_Self(t *testing.T) {
	body := `{"transactions":[{"transaction_id":"0.0.12345-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"SUCCESS","charged_tx_fee":1000000,"transfers":[{"account":"0.0.12345","amount":-100000000},{"account":"0.0.12345","amount":100000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	it := page.Items[0]
	if it.Direction != "self" {
		t.Errorf("Direction = %q, want self", it.Direction)
	}
	if it.AmountTinybars != 0 {
		t.Errorf("AmountTinybars = %d, want 0", it.AmountTinybars)
	}
	if it.HbarDisplay != "0.00000000 HBAR" {
		t.Errorf("HbarDisplay = %q, want 0.00000000 HBAR", it.HbarDisplay)
	}
	if it.From != "0.0.12345" || it.To != "0.0.12345" {
		t.Errorf("From/To = %q/%q, want 0.0.12345/0.0.12345", it.From, it.To)
	}
}

func TestGetTransactionHistory_Failed(t *testing.T) {
	body := `{"transactions":[{"transaction_id":"0.0.12345-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"INSUFFICIENT_PAYER_BALANCE","charged_tx_fee":1000000,"transfers":[{"account":"0.0.12345","amount":-1001000000},{"account":"0.0.67890","amount":1000000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	it := page.Items[0]
	if it.Status != "failed" {
		t.Errorf("Status = %q, want failed", it.Status)
	}
}

func TestGetTransactionHistory_TimestampParsing(t *testing.T) {
	body := `{"transactions":[{"transaction_id":"0.0.12345-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"SUCCESS","charged_tx_fee":0,"transfers":[{"account":"0.0.12345","amount":-100000000},{"account":"0.0.67890","amount":100000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	it := page.Items[0]
	if it.Timestamp != "2023-11-14T22:13:20Z" {
		t.Errorf("Timestamp = %q, want 2023-11-14T22:13:20Z", it.Timestamp)
	}
}

func TestGetTransactionHistory_PaginationRoundTrip(t *testing.T) {
	var lastRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("timestamp") == "" {
			// First page: carries a next link with a timestamp cursor.
			_, _ = w.Write([]byte(`{"transactions":[{"transaction_id":"0.0.1-1700000000-000000001","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.000000001","result":"SUCCESS","charged_tx_fee":0,"transfers":[{"account":"0.0.1","amount":-100000000},{"account":"0.0.2","amount":100000000}]}],"links":{"next":"/api/v1/transactions?account.id=0.0.1&limit=25&order=desc&type=CRYPTOTRANSFER&timestamp=lt:1699999000.000000111"}}`))
			return
		}
		// Second page: no further results.
		_, _ = w.Write([]byte(`{"transactions":[],"links":{"next":null}}`))
	}))
	defer srv.Close()

	mirror := NewMirror(MirrorConfig{BaseURL: srv.URL})
	svc := NewService(mirror)

	page, err := svc.GetTransactionHistory(context.Background(), "0.0.1", "")
	if err != nil {
		t.Fatalf("first page: unexpected error: %v", err)
	}
	if page.NextCursor == nil {
		t.Fatal("first page: NextCursor is nil, want non-nil")
	}
	if *page.NextCursor != "1699999000.000000111" {
		t.Fatalf("first page: NextCursor = %q, want 1699999000.000000111", *page.NextCursor)
	}

	page2, err := svc.GetTransactionHistory(context.Background(), "0.0.1", *page.NextCursor)
	if err != nil {
		t.Fatalf("second page: unexpected error: %v", err)
	}
	if page2.NextCursor != nil {
		t.Errorf("second page: NextCursor = %v, want nil", page2.NextCursor)
	}
	if !strings.Contains(lastRawQuery, "timestamp=lt:1699999000.000000111") {
		t.Errorf("second page request missing cursor in query: %q", lastRawQuery)
	}
}

func TestGetTransactionHistory_AccountAbsent(t *testing.T) {
	// The queried account is absent from every transfer leg. The default
	// branch classifies this as a self transfer with a zero amount.
	body := `{"transactions":[{"transaction_id":"0.0.1-1700000000-000000001","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.000000001","result":"SUCCESS","charged_tx_fee":0,"transfers":[{"account":"0.0.2","amount":-100000000},{"account":"0.0.3","amount":100000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("Items len = %d, want 1", len(page.Items))
	}
	it := page.Items[0]
	if it.Direction != "self" {
		t.Errorf("Direction = %q, want self", it.Direction)
	}
	if it.AmountTinybars != 0 {
		t.Errorf("AmountTinybars = %d, want 0", it.AmountTinybars)
	}
	if it.HbarDisplay != "0.00000000 HBAR" {
		t.Errorf("HbarDisplay = %q, want 0.00000000 HBAR", it.HbarDisplay)
	}
	if it.From != "0.0.12345" || it.To != "0.0.12345" {
		t.Errorf("From/To = %q/%q, want 0.0.12345/0.0.12345", it.From, it.To)
	}
}

func TestGetTransactionHistory_OutgoingOnlyFeeCredits(t *testing.T) {
	// Edge case: the account sends but every positive leg belongs to a fee
	// account, so there is no human recipient to surface. The recipient field
	// degrades to empty rather than naming a fee account.
	body := `{"transactions":[{"transaction_id":"0.0.12345-1700000000-123456789","name":"CRYPTOTRANSFER","consensus_timestamp":"1700000000.123456789","result":"SUCCESS","charged_tx_fee":1000000,"transfers":[{"account":"0.0.12345","amount":-1000000},{"account":"0.0.98","amount":1000000}]}],"links":{"next":null}}`
	mirror := mockMirrorResponse(t, http.StatusOK, body)
	svc := NewService(mirror)
	page, err := svc.GetTransactionHistory(context.Background(), "0.0.12345", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	it := page.Items[0]
	if it.Direction != "out" {
		t.Errorf("Direction = %q, want out", it.Direction)
	}
	if it.From != "0.0.12345" {
		t.Errorf("From = %q, want 0.0.12345", it.From)
	}
	if it.To != "" {
		t.Errorf("To = %q, want empty (no non-fee recipient)", it.To)
	}
}

func TestParseConsensusTimestamp_Malformed(t *testing.T) {
	// A consensus timestamp whose seconds part cannot be parsed is returned
	// unchanged rather than rendered as an empty or zero-time field.
	for _, in := range []string{"", "not-a-timestamp", "abc.def", "zzz"} {
		if got := parseConsensusTimestamp(in); got != in {
			t.Errorf("parseConsensusTimestamp(%q) = %q, want %q", in, got, in)
		}
	}
}
