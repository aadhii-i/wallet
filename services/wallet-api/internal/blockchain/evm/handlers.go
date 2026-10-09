package evm

import (
	"net/http"

	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

type Handlers struct {
	registry *Registry
}

func NewHandlers(registry *Registry) *Handlers {
	return &Handlers{registry: registry}
}

func networkJSON(n *Network) map[string]any {
	return map[string]any{
		"id":             n.ID,
		"family":         n.Family,
		"chainId":        n.ChainID,
		"name":           n.Name,
		"kind":           n.Kind,
		"nativeSymbol":   n.NativeSymbol,
		"nativeDecimals": n.NativeDecimals,
	}
}

func (h *Handlers) ListNetworks(w http.ResponseWriter, r *http.Request) {
	networks := h.registry.Enabled()
	out := make([]map[string]any, 0, len(networks))
	for _, n := range networks {
		out = append(out, networkJSON(n))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"networks": out})
}
