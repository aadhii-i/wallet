package sharedwallet

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

// HistoryIndex is the persistent chain index (internal/indexer).
type HistoryIndex interface {
	Sync(ctx context.Context, chainID int64, addresses []string, shared bool) error
}

// HistoryNetwork describes a chain Wallet History supports.
type HistoryNetwork struct {
	Name          string
	ExplorerTxURL func(hash string) string // "" when the chain has no public explorer
}

// SetIndex enables Wallet History; networks resolves a chain id to an enabled
// network (nil: every chain id is accepted).
func (h *Handlers) SetIndex(ix HistoryIndex, networks func(chainID int64) (*HistoryNetwork, bool), sanitize func(string) string) {
	h.index, h.networks, h.sanitize = ix, networks, sanitize
}

// Index states reported with Wallet History.
const (
	IndexOK             = "ok"              // indexed up to the chain head just now (or by a pass running right now)
	IndexRPCUnavailable = "rpc_unavailable" // the API has no RPC for this chain: stored history only
	IndexRPCError       = "rpc_error"       // the chain could not be read now: stored history only, may be incomplete
	IndexIndexing       = "indexing"        // still catching up (the request's time ran out): progress is kept, more appears shortly
	IndexDisabled       = "disabled"        // no chain index in this API
)

// WalletHistory is every indexed transfer of one shared wallet's smart
// accounts on one chain, with the proposal each execution belongs to.
type WalletHistory struct {
	Addresses  []string
	Transfers  []*store.ChainTransfer
	Proposals  map[string]uuid.UUID // tx hash → proposal of this wallet
	Coverage   map[string]*store.IndexCursor
	IndexState string
	IndexError error
}

// WalletHistory reads the wallet's smart accounts (all registered account
// keys, and every account an execution of this wallet used), indexes them on
// the chain now and returns their recorded transfers. Members only.
func (s *Service) WalletHistory(ctx context.Context, p *auth.Principal, walletID uuid.UUID, chainID int64, ix HistoryIndex) (*WalletHistory, error) {
	v, err := s.GetWallet(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	sw := s.store.SharedWallets()
	addrSet := map[string]bool{}
	for _, k := range v.AccountKeys {
		addrSet[strings.ToLower(k.Address)] = true
	}
	props, err := sw.ListProposals(ctx, walletID)
	if err != nil {
		return nil, err
	}
	h := &WalletHistory{Addresses: []string{}, Transfers: []*store.ChainTransfer{}, Proposals: map[string]uuid.UUID{}, Coverage: map[string]*store.IndexCursor{}, IndexState: IndexOK}
	for _, prop := range props {
		e, err := sw.GetExecution(ctx, prop.ID)
		if err != nil || e.ChainID != chainID {
			continue
		}
		if e.AccountAddress != "" {
			addrSet[strings.ToLower(e.AccountAddress)] = true // accounts of earlier keys too
		}
		if e.TxHash != "" {
			h.Proposals[strings.ToLower(e.TxHash)] = prop.ID
		}
	}
	for a := range addrSet {
		h.Addresses = append(h.Addresses, a)
	}
	sort.Strings(h.Addresses)
	if len(h.Addresses) == 0 {
		return h, nil
	}
	if ix == nil {
		h.IndexState = IndexDisabled
	} else {
		sctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		err := ix.Sync(sctx, chainID, h.Addresses, true)
		timedOut := sctx.Err() != nil && ctx.Err() == nil
		cancel()
		switch {
		case err == nil:
		case isNoRPC(err):
			h.IndexState, h.IndexError = IndexRPCUnavailable, err
		case timedOut || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, indexer.ErrIndexing):
			h.IndexState = IndexIndexing
		default:
			h.IndexState, h.IndexError = IndexRPCError, err
		}
	}
	ci := s.store.ChainIndex()
	recs, err := ci.ListTransfers(ctx, chainID, h.Addresses, 500)
	if err != nil {
		return nil, err
	}
	for _, r := range recs {
		// Only what moved value from or to the wallet's accounts (not, e.g.,
		// transactions some participant's EOA paid gas for elsewhere).
		if addrSet[r.From] || addrSet[r.To] {
			h.Transfers = append(h.Transfers, r)
		}
	}
	for _, a := range h.Addresses {
		if c, err := ci.GetCursor(ctx, chainID, a); err == nil {
			h.Coverage[a] = c
		}
	}
	return h, nil
}

func isNoRPC(err error) bool { return errors.Is(err, indexer.ErrNoRPC) }

// walletHistory implements GET /v1/shared-wallets/{walletId}/history?chainId=.
func (h *Handlers) walletHistory(w http.ResponseWriter, r *http.Request) {
	walletID, ok := pathID(w, r, "walletId")
	if !ok {
		return
	}
	raw := r.URL.Query().Get("chainId")
	chainID, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || chainID <= 0 {
		httpx.BadRequest(w, r, "INVALID_QUERY", "chainId (a positive integer) is required")
		return
	}
	network := &HistoryNetwork{Name: "chain " + raw, ExplorerTxURL: func(string) string { return "" }}
	if h.networks != nil {
		n, ok := h.networks(chainID)
		if !ok {
			httpx.BadRequest(w, r, "UNSUPPORTED_NETWORK", "chain "+raw+" is not a network this server supports")
			return
		}
		network = n
	}
	hist, err := h.svc.WalletHistory(r.Context(), auth.FromContext(r.Context()), walletID, chainID, h.index)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	mine := map[string]bool{}
	for _, a := range hist.Addresses {
		mine[a] = true
	}
	items := make([]map[string]any, 0, len(hist.Transfers))
	for _, t := range hist.Transfers {
		direction := "received"
		switch {
		case mine[t.From] && mine[t.To]:
			direction = "self"
		case mine[t.From]:
			direction = "sent"
		}
		status := "confirmed"
		if !t.Success {
			status = "failed"
		}
		item := map[string]any{
			"txHash": t.TxHash, "logIndex": t.LogIndex, "kind": t.Kind, "direction": direction,
			"from": t.From, "to": t.To, "token": t.Token, "amount": t.Amount, "success": t.Success, "status": status,
			"txFrom": t.TxFrom, "txTo": t.TxTo, "blockNumber": t.BlockNumber, "blockTime": ts(t.BlockTime),
			"gasUsed": t.GasUsed, "gasPriceWei": t.GasPriceWei, "feeWei": t.FeeWei,
		}
		if t.Kind != store.TransferInternal {
			if u := network.ExplorerTxURL(t.TxHash); u != "" {
				item["explorerUrl"] = u
			}
		}
		if pid, ok := hist.Proposals[t.TxHash]; ok {
			item["proposalId"] = pid.String()
		}
		items = append(items, item)
	}
	coverage := map[string]any{}
	for a, c := range hist.Coverage {
		coverage[a] = map[string]any{"sinceBlock": c.SinceBlock, "scannedThroughBlock": c.ScannedThrough}
	}
	index := map[string]any{"state": hist.IndexState}
	if hist.IndexError != nil {
		msg := hist.IndexError.Error()
		if h.sanitize != nil {
			msg = h.sanitize(msg)
		}
		index["error"] = msg
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"chainId": chainID, "network": network.Name, "addresses": hist.Addresses, "items": items, "coverage": coverage, "index": index,
	})
}
