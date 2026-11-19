package btc

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

// Handlers serves the Bitcoin endpoints. A nil service means Bitcoin is not
// configured at all; every route then answers 404 so the API does not leak
// whether a node exists.
type Handlers struct {
	svc *Service
}

// NewHandlers builds the Bitcoin HTTP handlers. svc may be nil.
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

// GetFees implements GET /v1/btc/{network}/fees.
func (h *Handlers) GetFees(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolve(w, r); !ok {
		return
	}
	quote, err := h.svc.Fees(r.Context())
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"fees": quote})
}

// GetUTXOs implements GET /v1/btc/{network}/address/{address}/utxos.
func (h *Handlers) GetUTXOs(w http.ResponseWriter, r *http.Request) {
	network, ok := h.resolve(w, r)
	if !ok {
		return
	}
	address := chi.URLParam(r, "address")
	if err := ValidateAddress(address, network); err != nil {
		httpx.BadRequest(w, r, "INVALID_ADDRESS", "address is not a valid address for this network")
		return
	}
	utxos, err := h.svc.UTXOs(r.Context(), address)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"utxos": utxos})
}

// GetHistory implements GET /v1/btc/{network}/address/{address}/history.
func (h *Handlers) GetHistory(w http.ResponseWriter, r *http.Request) {
	network, ok := h.resolve(w, r)
	if !ok {
		return
	}
	address := chi.URLParam(r, "address")
	if err := ValidateAddress(address, network); err != nil {
		httpx.BadRequest(w, r, "INVALID_ADDRESS", "address is not a valid address for this network")
		return
	}
	limit := defaultHistoryLimit
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= maxHistoryLimit {
			limit = n
		}
	}
	items, next, err := h.svc.History(r.Context(), address, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	resp := map[string]any{"items": items}
	if next != "" {
		resp["nextCursor"] = next
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

// GetTransaction implements GET /v1/btc/{network}/tx/{hash}.
func (h *Handlers) GetTransaction(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolve(w, r); !ok {
		return
	}
	hash := strings.TrimSpace(chi.URLParam(r, "hash"))
	if !validTxID(hash) {
		httpx.BadRequest(w, r, "INVALID_TXID", "transaction id must be 64 hex characters")
		return
	}
	detail, err := h.svc.Transaction(r.Context(), hash)
	if err != nil {
		if errors.Is(err, ErrTxNotFound) {
			httpx.NotFound(w, r, "NOT_FOUND", "")
			return
		}
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, detail)
}

// Broadcast implements POST /v1/btc/{network}/broadcast with body {"raw":"<hex>"}.
func (h *Handlers) Broadcast(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.resolve(w, r); !ok {
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		if strings.Contains(err.Error(), "too large") {
			httpx.BadRequest(w, r, "INVALID_TX", "raw transaction is too large")
			return
		}
		httpx.BadRequest(w, r, "INVALID_REQUEST", "could not read request body")
		return
	}
	var payload struct {
		Raw string `json:"raw"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		httpx.BadRequest(w, r, "INVALID_REQUEST", "body must be {\"raw\":\"<hex>\"}")
		return
	}
	txid, err := h.svc.Broadcast(r.Context(), payload.Raw)
	if err != nil {
		if errors.Is(err, ErrInvalidTx) {
			httpx.BadRequest(w, r, "INVALID_TX", "transaction was rejected by the Bitcoin node")
			return
		}
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"txid": txid})
}

// resolve checks the requested network against the configured one. A
// network this server does not serve is a 404, not a 400: the client must
// not be able to probe which networks exist.
func (h *Handlers) resolve(w http.ResponseWriter, r *http.Request) (Network, bool) {
	requested := Network(chi.URLParam(r, "network"))
	if !ValidNetwork(requested) {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return "", false
	}
	if h.svc == nil || !ValidNetwork(h.svc.Network()) || h.svc.Network() != requested {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return "", false
	}
	return requested, true
}

// validTxID reports whether hash looks like a transaction id.
func validTxID(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	for i := 0; i < len(hash); i++ {
		if !isHexDigit(hash[i]) {
			return false
		}
	}
	return true
}
