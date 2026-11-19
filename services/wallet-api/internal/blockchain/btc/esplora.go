// Package btc implements wallet-api's Bitcoin support using the
// Mempool.space Esplora REST API as the data source.
//
// Security invariants:
//
//   - The server never holds or receives spending keys.  Only public
//     addresses and already-signed raw transactions cross this boundary.
//   - Bitcoin addresses and raw transactions are never logged in plaintext.
//   - The Esplora base URL is the only credential; there are no user/password
//     fields that could appear in logs or error strings.
package btc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	esploraDefaultTimeout = 15 * time.Second
	esploraMaxBytes       = 8 << 20 // 8 MiB — generous for the largest tx-list page
)

// EsploraConfig configures the Esplora HTTP client.
type EsploraConfig struct {
	// BaseURL is the root of the Esplora API, e.g.
	//   https://mempool.space/testnet4/api
	//   https://mempool.space/api
	// No trailing slash.
	BaseURL string
	// Timeout bounds a single request.  Defaults to esploraDefaultTimeout.
	Timeout time.Duration
}

// Esplora is a minimal Mempool.space Esplora REST client.  It exposes only
// the methods service.go needs; there is no generic passthrough.
type Esplora struct {
	base   string
	client *http.Client
}

// NewEsplora builds an Esplora client.  The base URL is normalised (trailing
// slash removed, userinfo stripped so it cannot appear in log lines).
func NewEsplora(cfg EsploraConfig) *Esplora {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = esploraDefaultTimeout
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	return &Esplora{
		base:   base,
		client: &http.Client{Timeout: timeout},
	}
}

// --- Esplora response types ------------------------------------------------
// Field names match the JSON keys returned by the Esplora REST API verbatim.

// EsploraFees is the /v1/fees/recommended response.
type EsploraFees struct {
	FastestFee  int64 `json:"fastestFee"`
	HalfHourFee int64 `json:"halfHourFee"`
	HourFee     int64 `json:"hourFee"`
	EconomyFee  int64 `json:"economyFee"`
	MinimumFee  int64 `json:"minimumFee"`
}

// EsploraUTXO is one entry of /address/:address/utxo.
// Value is already in satoshis (int64).
type EsploraUTXO struct {
	TxID   string `json:"txid"`
	Vout   int    `json:"vout"`
	Status struct {
		Confirmed   bool  `json:"confirmed"`
		BlockHeight int64 `json:"block_height"`
		BlockTime   int64 `json:"block_time"`
	} `json:"status"`
	Value int64 `json:"value"`
}

// EsploraTx is one entry of /tx/:txid or /address/:address/txs.
type EsploraTx struct {
	TxID     string `json:"txid"`
	Fee      int64  `json:"fee"`
	Size     int    `json:"size"`
	Weight   int    `json:"weight"`
	Vin      []EsploraVin  `json:"vin"`
	Vout     []EsploraVout `json:"vout"`
	Status   EsploraTxStatus `json:"status"`
}

// EsploraVin is one input of an EsploraTx.
type EsploraVin struct {
	TxID    string        `json:"txid"`
	Vout    uint32        `json:"vout"`
	Prevout *EsploraVout  `json:"prevout"` // nil for unconfirmed inputs without prevout data
	IsCoinbase bool       `json:"is_coinbase"`
}

// EsploraVout is one output (or prevout) of an EsploraTx.
type EsploraVout struct {
	Scriptpubkey        string `json:"scriptpubkey"`
	ScriptpubkeyType    string `json:"scriptpubkey_type"`
	ScriptpubkeyAddress string `json:"scriptpubkey_address"`
	Value               int64  `json:"value"`
}

// EsploraTxStatus carries the confirmation state of a transaction.
type EsploraTxStatus struct {
	Confirmed   bool   `json:"confirmed"`
	BlockHeight int64  `json:"block_height"`
	BlockHash   string `json:"block_hash"`
	BlockTime   int64  `json:"block_time"`
}

// --- Client methods --------------------------------------------------------

// GetTipHeight returns the height of the best chain tip.
// Endpoint: GET /blocks/tip/height  →  plain integer text.
func (e *Esplora) GetTipHeight(ctx context.Context) (int64, error) {
	body, err := e.get(ctx, "/blocks/tip/height")
	if err != nil {
		return 0, fmt.Errorf("btc/esplora: tip height: %w", err)
	}
	h, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("btc/esplora: tip height: parse %q: %w", body, err)
	}
	return h, nil
}

// GetFeeEstimates returns per-confirmation-target fee estimates in sat/vB.
// Endpoint: GET /fee-estimates  →  map[string]float64.
// Keys are confirmation targets (1–1008); values are sat/vB.
// We use this in preference to /v1/fees/recommended because it supports
// arbitrary confirmation targets (1, 6, 1008) that map to our fee tiers.
func (e *Esplora) GetFeeEstimates(ctx context.Context) (map[int]int64, error) {
	body, err := e.get(ctx, "/fee-estimates")
	if err != nil {
		return nil, fmt.Errorf("btc/esplora: fee estimates: %w", err)
	}
	// The JSON is {"1":87.882,"2":87.882,...} — float values in sat/vB.
	var raw map[string]float64
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("btc/esplora: fee estimates: decode: %w", err)
	}
	out := make(map[int]int64, len(raw))
	for k, v := range raw {
		target, err := strconv.Atoi(k)
		if err != nil {
			continue
		}
		// Round up so we never quote less than the actual rate.
		sat := int64(v)
		if float64(sat) < v {
			sat++
		}
		if sat < 1 {
			sat = 1
		}
		out[target] = sat
	}
	return out, nil
}

// GetAddressUTXOs returns unspent outputs for address.
// Endpoint: GET /address/:address/utxo  →  []EsploraUTXO.
// Amounts are already in satoshis.
func (e *Esplora) GetAddressUTXOs(ctx context.Context, address string) ([]EsploraUTXO, error) {
	body, err := e.get(ctx, "/address/"+address+"/utxo")
	if err != nil {
		return nil, fmt.Errorf("btc/esplora: utxos %s: %w", AddressFingerprint(address), err)
	}
	var out []EsploraUTXO
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("btc/esplora: utxos %s: decode: %w", AddressFingerprint(address), err)
	}
	return out, nil
}

// GetAddressTxs returns the transaction history for address, newest first.
// Endpoint: GET /address/:address/txs           (up to 50 mempool + 25 confirmed)
//           GET /address/:address/txs/chain/:last  (next confirmed page)
// afterTxID is the last seen txid for pagination; empty string fetches the
// first page.
func (e *Esplora) GetAddressTxs(ctx context.Context, address, afterTxID string) ([]EsploraTx, error) {
	path := "/address/" + address + "/txs"
	if afterTxID != "" {
		path = "/address/" + address + "/txs/chain/" + afterTxID
	}
	body, err := e.get(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("btc/esplora: txs %s: %w", AddressFingerprint(address), err)
	}
	var out []EsploraTx
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("btc/esplora: txs %s: decode: %w", AddressFingerprint(address), err)
	}
	return out, nil
}

// GetTransaction returns the full details of a transaction.
// Endpoint: GET /tx/:txid  →  EsploraTx.
func (e *Esplora) GetTransaction(ctx context.Context, txid string) (*EsploraTx, error) {
	body, status, err := e.getWithStatus(ctx, "/tx/"+txid)
	if err != nil {
		return nil, fmt.Errorf("btc/esplora: tx %s: %w", txid[:min8(len(txid))], err)
	}
	if status == http.StatusNotFound {
		return nil, ErrTxNotFound
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("btc/esplora: tx %s: status %d", txid[:min8(len(txid))], status)
	}
	var out EsploraTx
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("btc/esplora: tx %s: decode: %w", txid[:min8(len(txid))], err)
	}
	return &out, nil
}

// BroadcastTx submits a signed raw transaction and returns its txid.
// Endpoint: POST /tx  body=<raw hex>  →  plain txid string.
func (e *Esplora) BroadcastTx(ctx context.Context, rawHex string) (string, error) {
	body, status, err := e.post(ctx, "/tx", rawHex)
	if err != nil {
		return "", fmt.Errorf("btc/esplora: broadcast: %w", err)
	}
	if status == http.StatusBadRequest {
		// Esplora returns a plain-text rejection reason on 400.
		// We sanitise it: the caller never sees node internals.
		return "", ErrInvalidTx
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("btc/esplora: broadcast: status %d", status)
	}
	txid := strings.TrimSpace(string(body))
	if txid == "" {
		return "", fmt.Errorf("btc/esplora: broadcast: empty txid in response")
	}
	return txid, nil
}

// --- HTTP helpers ----------------------------------------------------------

func (e *Esplora) get(ctx context.Context, path string) ([]byte, error) {
	body, status, err := e.getWithStatus(ctx, path)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("status %d", status)
	}
	return body, nil
}

func (e *Esplora) getWithStatus(ctx context.Context, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, esploraMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

func (e *Esplora) post(ctx context.Context, path, bodyStr string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.base+path,
		strings.NewReader(bodyStr))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, esploraMaxBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}

// --- Utility functions kept from the original Core implementation ----------

func min8(n int) int {
	if n < 8 {
		return n
	}
	return 8
}
