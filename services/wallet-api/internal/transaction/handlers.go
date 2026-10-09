package transaction

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Handlers struct {
	svc   *Service
	store store.Store
}

func NewHandlers(svc *Service, st store.Store) *Handlers {
	return &Handlers{svc: svc, store: st}
}

func txJSON(t *store.Transaction, events []*store.TransactionEvent) map[string]any {
	m := map[string]any{
		"id":        t.ID.String(),
		"networkId": t.NetworkID,
		"hash":      t.Hash,
		"from":      t.From,
		"to":        t.To,
		"assetId":   t.AssetID,
		"amount":    t.Amount,
		"status":    string(t.Status),
		"createdAt": t.CreatedAt.UTC().Format(time.RFC3339),
	}
	if t.Fee != nil {
		m["fee"] = *t.Fee
	}
	if t.Nonce != nil {
		m["nonce"] = *t.Nonce
	}
	if t.BlockNumber != nil {
		m["blockNumber"] = *t.BlockNumber
	}
	if events != nil {
		evOut := make([]map[string]any, 0, len(events))
		for _, e := range events {
			ev := map[string]any{
				"toStatus":   string(e.ToStatus),
				"observedAt": e.ObservedAt.UTC().Format(time.RFC3339),
			}
			if e.FromStatus != nil {
				ev["fromStatus"] = string(*e.FromStatus)
			}
			evOut = append(evOut, ev)
		}
		m["events"] = evOut
	}
	return m
}

type createRequest struct {
	NetworkID string `json:"networkId"`
	Hash      string `json:"hash"`
	AccountID string `json:"accountId"`
	From      string `json:"from"`
	To        string `json:"to"`
	AssetID   string `json:"assetId"`
	Amount    string `json:"amount"`
	Nonce     *int64 `json:"nonce"`
}

func (h *Handlers) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "")
		return
	}
	if req.NetworkID == "" || req.Hash == "" || req.AccountID == "" || req.From == "" || req.To == "" || req.AssetID == "" || req.Amount == "" {
		httpx.BadRequest(w, r, "INVALID_BODY", "networkId, hash, accountId, from, to, assetId and amount are required")
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "invalid accountId")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	httpx.IdempotentCreate(r.Context(), h.store.Idempotency(), p.UserID, key, "POST /v1/transactions", w, func() (int, any, error) {
		tx, err := h.svc.Create(r.Context(), p.UserID, CreateInput{
			NetworkID: req.NetworkID, Hash: req.Hash, AccountID: accountID,
			From: req.From, To: req.To, AssetID: req.AssetID, Amount: req.Amount, Nonce: req.Nonce,
		})
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				httpx.NotFound(w, r, "NOT_FOUND", "")
			} else if errors.Is(err, ErrFromAddressNotRegistered) {
				httpx.BadRequest(w, r, "FROM_NOT_REGISTERED", "from must be one of the account's registered addresses")
			} else {
				httpx.InternalError(w, r, "INTERNAL", "")
			}
			return 0, nil, err
		}
		return http.StatusCreated, txJSON(tx, nil), nil
	})
}

func (h *Handlers) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "transactionId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	tx, events, err := h.svc.Get(r.Context(), p.UserID, id)
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, txJSON(tx, events))
}
