package hedera

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

func serviceUnavailable(w http.ResponseWriter, r *http.Request, code, detail string) {
	httpx.WriteProblem(w, r, http.StatusServiceUnavailable, code, "Service unavailable", detail)
}

// Handlers serves the Hedera endpoints.
type Handlers struct {
	svc *Service
}

// NewHandlers builds the Hedera HTTP handlers.
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

// GetBalance implements GET /v1/hedera/{network}/account/{accountId}/balance.
// Only "testnet" is supported in this phase; any other value returns 404.
func (h *Handlers) GetBalance(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "network")
	if network != "testnet" {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}

	accountID := chi.URLParam(r, "accountId")
	balance, err := h.svc.GetAccountBalance(r.Context(), accountID)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidAccountID):
			httpx.BadRequest(w, r, "INVALID_ACCOUNT_ID", "account id must be in shard.realm.num format")
		case errors.Is(err, ErrAccountNotFound):
			httpx.NotFound(w, r, "NOT_FOUND", "account not found")
		default:
			serviceUnavailable(w, r, "MIRROR_NODE_ERROR", "mirror node unavailable")
		}
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"accountId": balance.AccountID,
		"tinybars":  balance.Tinybars,
		"hbar":      balance.HbarDisplay,
	})
}

// GetHistory implements GET /v1/hedera/{network}/account/{accountId}/history.
// Only "testnet" is supported in this phase; any other value returns 404. The
// optional ?cursor= query param pages through older transactions.
func (h *Handlers) GetHistory(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "network")
	if network != "testnet" {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}

	accountID := chi.URLParam(r, "accountId")
	cursor := r.URL.Query().Get("cursor")

	page, err := h.svc.GetTransactionHistory(r.Context(), accountID, cursor)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidAccountID):
			httpx.BadRequest(w, r, "INVALID_ACCOUNT_ID", "account id must be in shard.realm.num format")
		case errors.Is(err, ErrAccountNotFound):
			httpx.NotFound(w, r, "NOT_FOUND", "account not found")
		default:
			serviceUnavailable(w, r, "MIRROR_NODE_ERROR", "mirror node unavailable")
		}
		return
	}

	if r.URL.Query().Get("exact") == "true" {
		items := []map[string]any{}
		for _, item := range page.Items {
			items = append(items, map[string]any{"transactionId": item.TransactionID, "timestamp": item.Timestamp, "type": item.Type, "direction": item.Direction, "from": item.From, "to": item.To, "amountTinybars": strconv.FormatInt(item.AmountTinybars, 10), "hbar": item.HbarDisplay, "feeTinybars": strconv.FormatInt(item.FeeTinybars, 10), "status": item.Status, "networkId": item.NetworkID})
		}
		httpx.WriteJSON(w, 200, map[string]any{"items": items, "nextCursor": page.NextCursor})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, page)
}
