package sharedwallet

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func postProposal(t *testing.T, chainID int64) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	NewHandlers(nil).Routes(r)
	req := httptest.NewRequest(http.MethodPost,
		"/v1/shared-wallets/00000000-0000-0000-0000-000000000001/proposals",
		strings.NewReader(fmt.Sprintf(`{"chainId":%d}`, chainID)))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// The research-grade on-chain Raccoon verifier must never be used on a mainnet.
func TestSharedProposalRejectsMainnets(t *testing.T) {
	for _, chainID := range []int64{1, 8453, 42161, 137, 10, 0, -1} {
		rec := postProposal(t, chainID)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "UNSUPPORTED_CHAIN") {
			t.Errorf("chain %d: status %d, body %s; want 400 UNSUPPORTED_CHAIN", chainID, rec.Code, rec.Body)
		}
	}
}

// Test networks pass the chain check (the request then fails later, on its
// missing account ID, not on the chain).
func TestSharedProposalAcceptsTestnets(t *testing.T) {
	for _, chainID := range []int64{SepoliaChainID, 84532, 421614, 80002, 31337} {
		if !ExecutionChainAllowed(chainID) {
			t.Errorf("chain %d not allowed", chainID)
		}
		rec := postProposal(t, chainID)
		if strings.Contains(rec.Body.String(), "UNSUPPORTED_CHAIN") {
			t.Errorf("chain %d rejected as unsupported: %s", chainID, rec.Body)
		}
	}
}
