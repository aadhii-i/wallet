package rpc

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/go-chi/chi/v5"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
)

// Manager owns one Pool per enabled chain.
type Manager struct {
	registry *evm.Registry
	pools    map[int64]*Pool
}

func NewManager(registry *evm.Registry, pools map[int64]*Pool) *Manager {
	return &Manager{registry: registry, pools: pools}
}

func (m *Manager) Pool(chainID int64) (*Pool, bool) {
	p, ok := m.pools[chainID]
	return p, ok
}

// Handler serves POST /v1/rpc/evm/{chainId}. Per-session rate limiting is
// applied by auth.RateLimitBySession as separate middleware, since the
// session identity lives in the auth package's request context.
type Handler struct {
	mgr *Manager
}

func NewHandler(mgr *Manager) *Handler {
	return &Handler{mgr: mgr}
}

func methodTimeout(method string) time.Duration {
	switch method {
	case "eth_estimateGas":
		return 5 * time.Second
	case "eth_sendRawTransaction":
		return 10 * time.Second
	default:
		return 3 * time.Second
	}
}

func rpcErrorResponse(id json.RawMessage, code int, msg string) rpcEnvelope {
	return rpcEnvelope{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	chainIDStr := chi.URLParam(r, "chainId")
	chainID, err := strconv.ParseInt(chainIDStr, 10, 64)
	if err != nil {
		httpx.NotFound(w, r, "UNKNOWN_CHAIN", "invalid chain id")
		return
	}
	network, ok := h.mgr.registry.ByChainID(chainID)
	if !ok || !network.Enabled {
		httpx.NotFound(w, r, "UNKNOWN_CHAIN", "chain is not enabled on this server")
		return
	}
	pool, ok := h.mgr.Pool(chainID)
	if !ok {
		httpx.NotFound(w, r, "UNKNOWN_CHAIN", "chain is not enabled on this server")
		return
	}

	limited, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		httpx.BadRequest(w, r, "INVALID_BODY", "could not read body")
		return
	}
	if len(limited) > MaxBodyBytes {
		httpx.BadRequest(w, r, "BODY_TOO_LARGE", "request body exceeds the JSON-RPC proxy limit")
		return
	}

	isBatch := false
	trimmed := strings.TrimSpace(string(limited))
	if strings.HasPrefix(trimmed, "[") {
		isBatch = true
	}

	var items []rpcEnvelope
	if isBatch {
		if err := json.Unmarshal(limited, &items); err != nil {
			httpx.BadRequest(w, r, "INVALID_JSON", "invalid JSON-RPC batch")
			return
		}
		if len(items) > MaxBatchSize {
			httpx.BadRequest(w, r, "BATCH_TOO_LARGE", "batch exceeds the maximum of 20 calls")
			return
		}
	} else {
		var single rpcEnvelope
		if err := json.Unmarshal(limited, &single); err != nil {
			httpx.BadRequest(w, r, "INVALID_JSON", "invalid JSON-RPC request")
			return
		}
		items = []rpcEnvelope{single}
	}

	results := make([]rpcEnvelope, len(items))
	for i, item := range items {
		results[i] = h.handleOne(r.Context(), pool, chainID, item)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if isBatch {
		_ = json.NewEncoder(w).Encode(results)
	} else {
		_ = json.NewEncoder(w).Encode(results[0])
	}
}

func (h *Handler) handleOne(ctx context.Context, pool *Pool, chainID int64, req rpcEnvelope) rpcEnvelope {
	if !IsAllowed(req.Method) {
		return rpcErrorResponse(req.ID, -32601, "method not allowed: "+req.Method)
	}

	if req.Method == "eth_chainId" {
		chainHex := "0x" + strconv.FormatInt(chainID, 16)
		result, _ := json.Marshal(chainHex)
		return rpcEnvelope{JSONRPC: "2.0", ID: req.ID, Result: result}
	}

	if req.Method == "eth_getLogs" {
		normalized, err := validateAndNormalizeLogsFilter(req.Params)
		if err != nil {
			return rpcErrorResponse(req.ID, -32602, err.Error())
		}
		// Forward the re-serialized, single-interpretation filter we just
		// validated -- never the client's raw params. If the raw JSON had
		// duplicate or case-variant keys (e.g. both "fromBlock" and
		// "FromBlock"), our validation and the upstream's parser could
		// otherwise each pick a different value and disagree about which
		// range was actually approved, letting a wide range slip through
		// under a key our validator ignored. Rebuilding the object from the
		// single value we validated makes that ambiguity impossible.
		req.Params = normalized
	}

	if req.Method == "eth_sendRawTransaction" {
		return h.sendRawTransaction(ctx, pool, req)
	}

	return h.forwardRead(ctx, pool, req)
}

// logsFilter captures the fields wallet-api understands from an
// eth_getLogs filter object. Address/Topics are kept as raw JSON (opaque,
// forwarded as-is) since only the block range needs validation; fields we
// don't recognize (including a duplicate/differently-cased "fromBlock") are
// dropped entirely when we rebuild the object, which is the point.
type logsFilter struct {
	FromBlock string          `json:"fromBlock"`
	ToBlock   string          `json:"toBlock"`
	Address   json.RawMessage `json:"address,omitempty"`
	Topics    json.RawMessage `json:"topics,omitempty"`
}

// normalizedLogsFilter is the shape we always forward upstream: exactly one
// occurrence of each recognized key, with fromBlock/toBlock canonicalized to
// "0x"-prefixed hex.
type normalizedLogsFilter struct {
	FromBlock string          `json:"fromBlock"`
	ToBlock   string          `json:"toBlock"`
	Address   json.RawMessage `json:"address,omitempty"`
	Topics    json.RawMessage `json:"topics,omitempty"`
}

// validateAndNormalizeLogsFilter parses, validates, and re-serializes an
// eth_getLogs params array. It requires exactly one filter object with
// explicit hex fromBlock/toBlock (no "latest"/"pending"/"earliest" tags) and
// a range of at most MaxLogsRange blocks.
func validateAndNormalizeLogsFilter(params json.RawMessage) (json.RawMessage, error) {
	if err := rejectCaseVariantDuplicateKeys(params); err != nil {
		return nil, err
	}
	var arr []logsFilter
	if err := json.Unmarshal(params, &arr); err != nil || len(arr) != 1 {
		return nil, errors.New("eth_getLogs requires a single filter object with explicit fromBlock/toBlock")
	}
	f := arr[0]
	from, ok1 := parseHexBlock(f.FromBlock)
	to, ok2 := parseHexBlock(f.ToBlock)
	if !ok1 || !ok2 {
		return nil, errors.New("eth_getLogs requires explicit hex fromBlock/toBlock (no tags)")
	}
	if to < from {
		return nil, errors.New("eth_getLogs toBlock must be >= fromBlock")
	}
	if to-from > MaxLogsRange {
		return nil, errors.New("eth_getLogs range exceeds the maximum of 2000 blocks")
	}
	normalized := []normalizedLogsFilter{{
		FromBlock: "0x" + strconv.FormatUint(from, 16),
		ToBlock:   "0x" + strconv.FormatUint(to, 16),
		Address:   f.Address,
		Topics:    f.Topics,
	}}
	out, err := json.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// rejectCaseVariantDuplicateKeys refuses an eth_getLogs filter that carries two
// keys differing only by case (for example "toBlock" beside "ToBlock").
//
// encoding/json matches struct fields to keys case-insensitively and assigns in
// the order the keys appear in the document, so the later variant silently
// overwrites the earlier one. Rebuilding the filter drops the surplus key but
// not the value it won, which means the range we validate and forward would be
// the one the duplicate supplied. Decoding into a map preserves both spellings,
// so the ambiguity can be refused instead of resolved by accident.
func rejectCaseVariantDuplicateKeys(params json.RawMessage) error {
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(params, &arr); err != nil {
		return nil // the struct decode below reports the real error
	}
	for _, filter := range arr {
		keys := make([]string, 0, len(filter))
		for key := range filter {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		seen := make(map[string]string, len(keys))
		for _, key := range keys {
			lower := strings.ToLower(key)
			if first, ok := seen[lower]; ok {
				return fmt.Errorf("eth_getLogs filter has duplicate keys %q and %q", first, key)
			}
			seen[lower] = key
		}
	}
	return nil
}

// forwardRead tries providers in priority order (failover), skipping
// open-circuit providers, for read methods only. On failure it returns a
// generic message to the client -- the underlying transport error (which
// for a *url.Error includes the full upstream URL, and thus any API key)
// must never reach the response body. Providers already log the sanitized
// (provider name + unwrapped cause, never URL) detail themselves.
func (h *Handler) forwardRead(ctx context.Context, pool *Pool, req rpcEnvelope) rpcEnvelope {
	timeout := methodTimeout(req.Method)
	for _, prov := range pool.candidates() {
		resp, err := prov.call(ctx, pool.chainLabel(), req, timeout)
		if err != nil {
			if shouldCountAsProviderFailure(err, req.Method) {
				prov.recordFailure()
			}
			if isReadMethod(req.Method) {
				continue
			}
			break
		}
		prov.recordSuccess()
		resp.ID = req.ID
		return *resp
	}
	return rpcErrorResponse(req.ID, -32603, "upstream unavailable")
}

// sendRawTransaction implements the careful broadcast policy from spec
// §25.2: send to the primary; on timeout/failure, check
// eth_getTransactionByHash on other providers using the hash computed
// locally from the raw bytes (never trust an upstream to tell us the hash);
// only if not found there is the SAME raw payload resent to the next
// provider. It never re-signs or mutates the payload.
func (h *Handler) sendRawTransaction(ctx context.Context, pool *Pool, req rpcEnvelope) rpcEnvelope {
	var params []string
	if err := json.Unmarshal(req.Params, &params); err != nil || len(params) == 0 {
		return rpcErrorResponse(req.ID, -32602, "eth_sendRawTransaction requires the raw signed transaction")
	}
	rawHex := strings.TrimPrefix(params[0], "0x")
	rawBytes, err := hex.DecodeString(rawHex)
	if err != nil {
		return rpcErrorResponse(req.ID, -32602, "invalid raw transaction hex")
	}
	var tx types.Transaction
	if err := tx.UnmarshalBinary(rawBytes); err != nil {
		return rpcErrorResponse(req.ID, -32602, "could not decode raw transaction")
	}
	txHash := tx.Hash().Hex()

	providers := pool.candidates()
	if len(providers) == 0 {
		return rpcErrorResponse(req.ID, -32603, "no upstream providers configured")
	}

	timeout := methodTimeout("eth_sendRawTransaction")
	primary := providers[0]
	resp, err := primary.call(ctx, pool.chainLabel(), req, timeout)
	if err == nil && resp.Error == nil {
		primary.recordSuccess()
		resp.ID = req.ID
		return *resp
	}
	primary.recordFailure()

	// Timeout/failure: check other providers for the tx before resending.
	for _, prov := range providers[1:] {
		if found, ferr := checkTxKnown(ctx, prov, pool.chainLabel(), txHash); ferr == nil && found {
			result, _ := json.Marshal(txHash)
			return rpcEnvelope{JSONRPC: "2.0", ID: req.ID, Result: result}
		}
	}

	// Not seen anywhere: resend the identical raw bytes to the next
	// provider (safe: resending identical signed bytes never double-spends
	// beyond what the network itself dedups by hash).
	for _, prov := range providers[1:] {
		resp, err := prov.call(ctx, pool.chainLabel(), req, timeout)
		if err != nil || (resp != nil && resp.Error != nil) {
			prov.recordFailure()
			continue
		}
		prov.recordSuccess()
		resp.ID = req.ID
		return *resp
	}

	return rpcErrorResponse(req.ID, -32603, "eth_sendRawTransaction failed on all upstream providers")
}

func checkTxKnown(ctx context.Context, prov *Provider, chainLabel, txHash string) (bool, error) {
	params, _ := json.Marshal([]string{txHash})
	req := rpcEnvelope{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "eth_getTransactionByHash", Params: params}
	resp, err := prov.call(ctx, chainLabel, req, 3*time.Second)
	if err != nil {
		return false, err
	}
	if resp.Error != nil {
		return false, nil
	}
	return string(resp.Result) != "null" && len(resp.Result) > 0, nil
}
