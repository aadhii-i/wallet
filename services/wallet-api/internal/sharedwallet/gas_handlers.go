package sharedwallet

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

// SetRelayer enables the gas-service endpoints (estimate and history).
func (h *Handlers) SetRelayer(r *Relayer) { h.relayer = r }

func (h *Handlers) gasRoutes(r chi.Router) {
	r.Get("/v1/proposals/{proposalId}/gas-estimate", h.gasEstimate)
	r.Get("/v1/gas-service/{chainId}/history", h.gasHistory)
}

func (h *Handlers) gasEstimate(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "proposalId")
	if !ok {
		return
	}
	v, err := h.svc.GetProposal(r.Context(), auth.FromContext(r.Context()), id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if h.relayer == nil {
		httpx.WriteProblem(w, r, http.StatusServiceUnavailable, "RELAYER_DISABLED", "Relayer disabled", "the shared-wallet relayer is not running")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	est, err := h.relayer.EstimateProposal(ctx, v.Proposal, v.AccountKey)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, est)
}

func (h *Handlers) gasHistory(w http.ResponseWriter, r *http.Request) {
	chainID, err := strconv.ParseInt(chi.URLParam(r, "chainId"), 10, 64)
	if err != nil || h.relayer == nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	limit := 200
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	hist, err := h.relayer.History(r.Context(), chainID, limit)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	p := auth.FromContext(r.Context())
	// Proposal links are shown only to members of that proposal's wallet.
	visible := map[string]bool{}
	items := make([]map[string]any, 0, len(hist.Transfers))
	for _, t := range hist.Transfers {
		items = append(items, gasTransferJSON(t, func(id string) bool {
			seen, ok := visible[id]
			if !ok {
				uid := *t.ProposalID
				_, _, err := h.svc.proposalForMember(r.Context(), p, uid)
				seen = err == nil
				visible[id] = seen
			}
			return seen
		}))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"chainId": hist.ChainID, "address": hist.Address, "transfers": items,
		"scannedThroughBlock": hist.ScannedThroughBlock, "historyAvailableSinceBlock": hist.HistoryAvailableSince,
	})
}

func gasTransferJSON(t *store.GasTransfer, canSee func(string) bool) map[string]any {
	m := map[string]any{
		"txHash": t.TxHash, "direction": t.Direction, "kind": t.Kind, "counterparty": t.Counterparty,
		"valueWei": t.ValueWei, "gasUsed": t.GasUsed, "gasPriceWei": t.GasPriceWei, "feeWei": t.FeeWei,
		"success": t.Success, "blockNumber": t.BlockNumber, "blockTime": ts(t.BlockTime),
	}
	if t.ProposalID != nil && canSee(t.ProposalID.String()) {
		m["proposalId"] = t.ProposalID.String()
	}
	return m
}
