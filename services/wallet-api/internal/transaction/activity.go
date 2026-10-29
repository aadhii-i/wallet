package transaction

import (
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/store"
)

// ActivityProviders resolves a HistoryProvider per network id, e.g. from
// config.HISTORY_PROVIDER_<chainId>.
type ActivityProviders interface {
	ProviderFor(networkID string) evm.HistoryProvider
}

type ActivityHandlers struct {
	store     store.Store
	providers ActivityProviders
}

func NewActivityHandlers(st store.Store, providers ActivityProviders) *ActivityHandlers {
	return &ActivityHandlers{store: st, providers: providers}
}

type mergedItem struct {
	Hash        string
	NetworkID   string
	Direction   string
	From        string
	To          string
	AssetID     string
	Amount      string
	Fee         string
	Status      string
	BlockNumber int64
	Timestamp   time.Time
	Flags       []string
}

// GetActivity implements GET /v1/accounts/{id}/activity?network=&cursor=&limit=.
func (h *ActivityHandlers) GetActivity(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	accountID, err := uuid.Parse(chi.URLParam(r, "accountId"))
	if err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}
	networkID := r.URL.Query().Get("network")
	if networkID == "" {
		httpx.BadRequest(w, r, "INVALID_QUERY", "network is required")
		return
	}
	limit := 25
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	offset := 0
	if c := r.URL.Query().Get("cursor"); c != "" {
		if n, ok := decodeCursor(c); ok {
			offset = n
		}
	}

	if _, err := h.store.Accounts().Get(r.Context(), p.UserID, accountID); err != nil {
		httpx.NotFound(w, r, "NOT_FOUND", "")
		return
	}

	addresses, err := h.store.Addresses().ListByAccount(r.Context(), p.UserID, accountID)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}
	var addrStrings []string
	for _, a := range addresses {
		addrStrings = append(addrStrings, a.Address)
	}

	tracked, err := h.store.Transactions().ListByAccount(r.Context(), p.UserID, accountID, networkID)
	if err != nil {
		httpx.InternalError(w, r, "INTERNAL", "")
		return
	}

	merged := trackedToMerged(tracked, addrStrings)

	if h.providers != nil {
		if provider := h.providers.ProviderFor(networkID); provider != nil {
			sentTo := sentToSet(merged)
			items, err := provider.FetchActivity(r.Context(), networkID, addrStrings)
			if err == nil {
				flagged := evm.DetectPoisoning(items, sentTo)
				merged = append(merged, providerToMerged(flagged)...)
			}
		}
	}

	merged = dedupeByHash(merged)
	sort.Slice(merged, func(i, j int) bool { return merged[i].Timestamp.After(merged[j].Timestamp) })

	end := offset + limit
	var page []mergedItem
	var nextCursor string
	if offset < len(merged) {
		if end > len(merged) {
			end = len(merged)
		} else {
			nextCursor = encodeCursor(end)
		}
		page = merged[offset:end]
	}

	out := make([]map[string]any, 0, len(page))
	for _, item := range page {
		out = append(out, map[string]any{
			"hash":        item.Hash,
			"networkId":   item.NetworkID,
			"direction":   item.Direction,
			"from":        item.From,
			"to":          item.To,
			"assetId":     item.AssetID,
			"amount":      item.Amount,
			"status":      item.Status,
			"blockNumber": item.BlockNumber,
			"timestamp":   item.Timestamp.UTC().Format(time.RFC3339),
			"flags":       flagsForResponse(item.Flags),
		})
	}
	resp := map[string]any{"items": out}
	if nextCursor != "" {
		resp["nextCursor"] = nextCursor
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

func trackedToMerged(txs []*store.Transaction, addresses []string) []mergedItem {
	addrSet := map[string]struct{}{}
	for _, a := range addresses {
		addrSet[strings.ToLower(a)] = struct{}{}
	}
	out := make([]mergedItem, 0, len(txs))
	for _, tx := range txs {
		direction := "out"
		_, fromKnown := addrSet[strings.ToLower(tx.From)]
		_, toKnown := addrSet[strings.ToLower(tx.To)]
		if fromKnown && toKnown {
			direction = "self"
		} else if toKnown && !fromKnown {
			direction = "in"
		}
		fee := ""
		if tx.Fee != nil {
			fee = *tx.Fee
		}
		var blockNum int64
		if tx.BlockNumber != nil {
			blockNum = *tx.BlockNumber
		}
		out = append(out, mergedItem{
			Hash: tx.Hash, NetworkID: tx.NetworkID, Direction: direction,
			From: tx.From, To: tx.To, AssetID: tx.AssetID, Amount: tx.Amount, Fee: fee,
			Status: string(tx.Status), BlockNumber: blockNum, Timestamp: tx.CreatedAt, Flags: tx.Flags,
		})
	}
	return out
}

func providerToMerged(items []evm.ActivityItem) []mergedItem {
	out := make([]mergedItem, 0, len(items))
	for _, item := range items {
		ts := time.Unix(item.Timestamp, 0).UTC()
		if item.Timestamp == 0 {
			ts = time.Now().UTC()
		}
		out = append(out, mergedItem{
			Hash: item.Hash, NetworkID: item.NetworkID, Direction: item.Direction,
			From: item.From, To: item.To, AssetID: item.AssetID, Amount: item.Amount, Fee: item.Fee,
			Status: item.Status, BlockNumber: item.BlockNumber, Timestamp: ts, Flags: item.Flags,
		})
	}
	return out
}

// flagsForResponse keeps the openapi.yaml ActivityItem contract, which declares
// flags as a required array. A nil Go slice marshals to JSON null, and the web
// client dereferences it unguarded.
func flagsForResponse(flags []string) []string {
	if flags == nil {
		return []string{}
	}
	return flags
}

func sentToSet(items []mergedItem) map[string]struct{} {
	out := map[string]struct{}{}
	for _, item := range items {
		if item.Direction == "out" || item.Direction == "self" {
			out[strings.ToLower(item.To)] = struct{}{}
		}
	}
	return out
}

func dedupeByHash(items []mergedItem) []mergedItem {
	seen := map[string]struct{}{}
	out := make([]mergedItem, 0, len(items))
	for _, item := range items {
		key := item.NetworkID + "|" + strings.ToLower(item.Hash)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeCursor(c string) (int, bool) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(string(b))
	if err != nil {
		return 0, false
	}
	return n, true
}
