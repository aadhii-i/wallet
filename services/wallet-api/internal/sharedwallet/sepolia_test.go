package sharedwallet

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestSharedProposalRejectsNonSepoliaChain(t *testing.T) {
	r := chi.NewRouter()
	NewHandlers(nil).Routes(r)
	req := httptest.NewRequest(http.MethodPost,
		"/v1/shared-wallets/00000000-0000-0000-0000-000000000001/proposals",
		strings.NewReader(`{"chainId":84532}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "UNSUPPORTED_CHAIN") {
		t.Fatalf("non-Sepolia proposal: status %d, body %s", rec.Code, rec.Body)
	}
}
