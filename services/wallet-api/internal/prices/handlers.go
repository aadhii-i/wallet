package prices

import (
	"net/http"
	"strings"
	"time"

	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

type Handlers struct {
	provider Provider
}

func NewHandlers(provider Provider) *Handlers {
	return &Handlers{provider: provider}
}

func (h *Handlers) GetPrices(w http.ResponseWriter, r *http.Request) {
	idsParam := r.URL.Query().Get("ids")
	if idsParam == "" {
		httpx.BadRequest(w, r, "INVALID_QUERY", "ids is required")
		return
	}
	ids := strings.Split(idsParam, ",")
	if len(ids) > MaxIDs {
		httpx.BadRequest(w, r, "TOO_MANY_IDS", "at most 50 ids are allowed")
		return
	}
	prices, err := h.provider.FetchPrices(r.Context(), ids)
	if err != nil {
		httpx.InternalError(w, r, "PRICE_PROVIDER_ERROR", "")
		return
	}
	out := make(map[string]map[string]string, len(prices))
	for id, usd := range prices {
		out[id] = map[string]string{"usd": usd}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"prices":    out,
		"updatedAt": time.Now().UTC().Format(time.RFC3339),
	})
}
