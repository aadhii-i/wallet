package btc

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// Errors surfaced to the HTTP layer.
var (
	// ErrInvalidTxID means the transaction id is not a 64-character hex string.
	ErrInvalidTxID = errors.New("invalid transaction id")
	// ErrInvalidTx means the raw transaction was malformed or rejected by Esplora.
	ErrInvalidTx = errors.New("invalid raw transaction")
	// ErrTxNotFound means Esplora does not know the transaction.
	ErrTxNotFound = errors.New("transaction not found")
)

const (
	// feeConfLow is the confirmation target for the "low" fee tier.
	feeConfLow = 1008
	// feeConfMarket is the confirmation target for the "market" fee tier.
	feeConfMarket = 6
	// feeConfAggressive is the confirmation target for the "aggressive" fee tier.
	feeConfAggressive = 1

	// defaultHistoryLimit is the page size of the history endpoint.
	defaultHistoryLimit = 25
	// maxHistoryLimit caps the client-controlled page size.
	maxHistoryLimit = 100

	// maxRawHexLen bounds the size of a broadcast payload (hex characters).
	maxRawHexLen = 100_000
)

// Service holds the Bitcoin business logic backed by Esplora.
type Service struct {
	esplora  *Esplora
	network  Network
	feeFloor int64
	feeMax   int64
	logger   *slog.Logger
	now      func() time.Time
}

// FeeQuote is the fees endpoint payload.  Rates are sat/vB.
type FeeQuote struct {
	Low        int64  `json:"low"`
	Market     int64  `json:"market"`
	Aggressive int64  `json:"aggressive"`
	TipHeight  int64  `json:"tipHeight"`
	QuotedAt   string `json:"quotedAt"`
}

// UTXO is one spendable output.  Monetary values are decimal strings in
// satoshis so no float ever reaches the client.
type UTXO struct {
	TxID          string `json:"txid"`
	Vout          int    `json:"vout"`
	Value         string `json:"value"`
	ScriptPubKey  string `json:"scriptPubKey"`
	Confirmations int64  `json:"confirmations"`
	BlockHeight   *int64 `json:"blockHeight,omitempty"`
}

// ActivityItem mirrors the shared ActivityItem contract used by the EVM
// history endpoint.
type ActivityItem struct {
	Hash        string   `json:"hash"`
	NetworkID   string   `json:"networkId"`
	Direction   string   `json:"direction"`
	From        string   `json:"from"`
	To          string   `json:"to"`
	AssetID     string   `json:"assetId"`
	Amount      string   `json:"amount"`
	Fee         *string  `json:"fee,omitempty"`
	Status      string   `json:"status"`
	BlockNumber *int64   `json:"blockNumber,omitempty"`
	Timestamp   string   `json:"timestamp"`
	Flags       []string `json:"flags"`
}

// TxInput is one input of a transaction.
type TxInput struct {
	Address *string `json:"address,omitempty"`
	Value   string  `json:"value"`
}

// TxOutput is one output of a transaction.
type TxOutput struct {
	Address *string `json:"address,omitempty"`
	Value   string  `json:"value"`
}

// TxDetail is the transaction lookup payload.
type TxDetail struct {
	TxID          string     `json:"txid"`
	Status        string     `json:"status"`
	Confirmations int64      `json:"confirmations"`
	BlockHeight   *int64     `json:"blockHeight,omitempty"`
	BlockTime     *string    `json:"blockTime,omitempty"`
	Fee           *string    `json:"fee,omitempty"`
	Value         string     `json:"value"`
	Inputs        []TxInput  `json:"inputs"`
	Outputs       []TxOutput `json:"outputs"`
}

// NewService builds the Bitcoin service.  feeFloor and feeMax are the
// sat/vB bounds every quoted rate is clamped into.
func NewService(esplora *Esplora, network Network, feeFloor, feeMax int64, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	if feeFloor < 1 {
		feeFloor = 1
	}
	if feeMax < feeFloor {
		feeMax = feeFloor
	}
	return &Service{
		esplora:  esplora,
		network:  network,
		feeFloor: feeFloor,
		feeMax:   feeMax,
		logger:   logger,
		now:      time.Now,
	}
}

// Network returns the network this server is configured for.
func (s *Service) Network() Network { return s.network }

// NetworkID returns the network id used in activity items.
func (s *Service) NetworkID() string {
	if s.network == NetworkTestnet4 {
		return "btc-testnet4"
	}
	return "btc-mainnet"
}

// FeeFloor returns the configured minimum fee rate in sat/vB.
func (s *Service) FeeFloor() int64 { return s.feeFloor }

// FeeMax returns the configured maximum fee rate in sat/vB.
func (s *Service) FeeMax() int64 { return s.feeMax }

// Fees quotes the current fee tiers from Esplora.
//
// /fee-estimates returns a map keyed by confirmation target (as a string)
// with float64 sat/vB values.  We read targets 1, 6 and 1008 to build the
// three tiers and clamp them into the configured [floor, max] band.
func (s *Service) Fees(ctx context.Context) (FeeQuote, error) {
	quote := FeeQuote{QuotedAt: s.now().UTC().Format(time.RFC3339)}

	// Tip height — best-effort; a failure does not prevent fee quoting.
	if h, err := s.esplora.GetTipHeight(ctx); err != nil {
		s.logger.Warn("bitcoin: tip height unavailable", slog.String("error", err.Error()))
	} else {
		quote.TipHeight = h
	}

	estimates, err := s.esplora.GetFeeEstimates(ctx)
	if err != nil {
		s.logger.Warn("bitcoin: fee estimates unavailable", slog.String("error", err.Error()))
		// Fall back to the floor rate so the client can still build a transaction.
		quote.Low = s.feeFloor
		quote.Market = s.feeFloor
		quote.Aggressive = s.feeFloor
		return quote, nil
	}

	quote.Low = s.clampRate(rateForTarget(estimates, feeConfLow))
	quote.Market = s.clampRate(rateForTarget(estimates, feeConfMarket))
	quote.Aggressive = s.clampRate(rateForTarget(estimates, feeConfAggressive))
	return quote, nil
}

// rateForTarget picks the sat/vB rate for a confirmation target from the
// estimates map.  Targets are 1–25, 144, 504 and 1008; if the exact target
// is missing, the nearest higher target is used.
func rateForTarget(estimates map[int]int64, target int) int64 {
	if r, ok := estimates[target]; ok {
		return r
	}
	// Walk up to the first available target.
	for t := target + 1; t <= 1008; t++ {
		if r, ok := estimates[t]; ok {
			return r
		}
	}
	return 0 // signals "no estimate"; caller will clamp to floor
}

// clampRate confines a rate into [floor, max]; 0 (no estimate) becomes the
// floor.
func (s *Service) clampRate(rate int64) int64 {
	if rate < s.feeFloor {
		return s.feeFloor
	}
	if rate > s.feeMax {
		return s.feeMax
	}
	return rate
}

// UTXOs returns the unspent outputs for the given address directly from
// Esplora.  No server-side wallet or descriptor import is required.
func (s *Service) UTXOs(ctx context.Context, address string) ([]UTXO, error) {
	raw, err := s.esplora.GetAddressUTXOs(ctx, address)
	if err != nil {
		return nil, fmt.Errorf("btc: utxos: %w", err)
	}
	if len(raw) > 10000 {
		return nil, errors.New("UTXO response exceeds the wallet limit")
	}
	tip, err := s.esplora.GetTipHeight(ctx)
	if err != nil {
		return nil, errors.New("could not determine UTXO confirmations")
	}
	seen := make(map[string]bool)
	items := make([]UTXO, 0, len(raw))
	for _, u := range raw {
		key := fmt.Sprintf("%s:%d", strings.ToLower(u.TxID), u.Vout)
		if !validTxID(u.TxID) || u.Vout < 0 || uint64(u.Vout) > 0xffffffff || u.Value <= 0 || u.Value > 2100000000000000 || seen[key] {
			return nil, errors.New("invalid upstream UTXO")
		}
		seen[key] = true
		item := UTXO{
			TxID:  u.TxID,
			Vout:  u.Vout,
			Value: strconv.FormatInt(u.Value, 10),
			// Esplora does not return scriptPubKey in the UTXO list.
			// The frontend client builds it from the address itself
			// (packages/bitcoin/src/address.ts:scriptPubKeyHex), so we
			// leave this empty; service_test.go covers this behaviour.
		}
		if u.Status.Confirmed {
			if u.Status.BlockHeight <= 0 || u.Status.BlockHeight > tip {
				return nil, errors.New("invalid UTXO block height")
			}
			item.Confirmations = tip - u.Status.BlockHeight + 1
			if u.Status.BlockHeight > 0 {
				h := u.Status.BlockHeight
				item.BlockHeight = &h
			}
		}
		items = append(items, item)
	}
	return items, nil
}

// History returns the activity of an address, newest first, paginated with
// an opaque base64url cursor that encodes the last-seen txid.
func (s *Service) History(ctx context.Context, address, cursor string, limit int) ([]ActivityItem, string, error) {
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	if limit > maxHistoryLimit {
		limit = maxHistoryLimit
	}

	afterTxID := decodeCursor(cursor)
	txs, err := s.esplora.GetAddressTxs(ctx, address, afterTxID)
	if err != nil {
		return nil, "", fmt.Errorf("btc: history: %w", err)
	}

	items := make([]ActivityItem, 0, len(txs))
	for _, tx := range txs {
		item := s.activityItemFromTx(tx, address)
		if item == nil {
			continue // coinbase or unattributable
		}
		items = append(items, *item)
	}

	// Apply the page limit.
	next := ""
	if len(items) > limit {
		items = items[:limit]
	}
	// If Esplora returned a full page (25 confirmed), there may be more.
	// Encode the last item's txid as the next-page cursor.
	if len(txs) >= 25 && len(items) == limit {
		last := txs[len(txs)-1].TxID
		next = encodeCursor(last)
	}
	return items, next, nil
}

// activityItemFromTx classifies a transaction with respect to address and
// returns an ActivityItem.  Returns nil for coinbase transactions and those
// that cannot be attributed to the address (should not happen in practice).
func (s *Service) activityItemFromTx(tx EsploraTx, address string) *ActivityItem {
	// Determine direction by checking whether the address appears in inputs
	// (sending) or outputs (receiving) or both (self-transfer).
	spends := false
	receives := false
	var totalIn, totalOut int64

	for _, vin := range tx.Vin {
		if vin.IsCoinbase {
			return nil
		}
		if vin.Prevout != nil {
			totalIn += vin.Prevout.Value
			if strings.EqualFold(vin.Prevout.ScriptpubkeyAddress, address) {
				spends = true
			}
		}
	}
	for _, vout := range tx.Vout {
		totalOut += vout.Value
		if strings.EqualFold(vout.ScriptpubkeyAddress, address) {
			receives = true
		}
	}

	if !spends && !receives {
		return nil
	}

	direction := "in"
	if spends && receives {
		direction = "self"
	} else if spends {
		direction = "out"
	}

	// Net amount: for incoming use the sum of outputs to the address;
	// for outgoing use the absolute value of the net reduction.
	var amount int64
	for _, vout := range tx.Vout {
		if strings.EqualFold(vout.ScriptpubkeyAddress, address) {
			amount += vout.Value
		}
	}
	if direction == "out" || direction == "self" {
		// Use total value sent to outputs that are NOT the address.
		amount = 0
		for _, vout := range tx.Vout {
			if !strings.EqualFold(vout.ScriptpubkeyAddress, address) {
				amount += vout.Value
			}
		}
	}
	if amount < 0 {
		amount = -amount
	}

	item := ActivityItem{
		Hash:      tx.TxID,
		NetworkID: s.NetworkID(),
		Direction: direction,
		AssetID:   "btc",
		Amount:    strconv.FormatInt(amount, 10),
		Status:    "pending",
		Timestamp: s.now().UTC().Format(time.RFC3339),
		Flags:     []string{},
	}

	if tx.Status.Confirmed {
		item.Status = "confirmed"
		if tx.Status.BlockHeight > 0 {
			h := tx.Status.BlockHeight
			item.BlockNumber = &h
		}
		if tx.Status.BlockTime > 0 {
			t := time.Unix(tx.Status.BlockTime, 0).UTC().Format(time.RFC3339)
			item.Timestamp = t
		}
	}

	// Populate From/To with the best available addresses.
	switch direction {
	case "in":
		item.To = address
		for _, vin := range tx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptpubkeyAddress != "" {
				item.From = vin.Prevout.ScriptpubkeyAddress
				break
			}
		}
	case "out", "self":
		item.From = address
		for _, vout := range tx.Vout {
			if !strings.EqualFold(vout.ScriptpubkeyAddress, address) && vout.ScriptpubkeyAddress != "" {
				item.To = vout.ScriptpubkeyAddress
				break
			}
		}
	}

	if tx.Fee > 0 && (direction == "out" || direction == "self") {
		f := strconv.FormatInt(tx.Fee, 10)
		item.Fee = &f
	}

	return &item
}

// Transaction returns the details of a transaction.
func (s *Service) Transaction(ctx context.Context, hash string) (*TxDetail, error) {
	tx, err := s.esplora.GetTransaction(ctx, hash)
	if err != nil {
		return nil, err // ErrTxNotFound propagates as-is
	}

	detail := &TxDetail{
		TxID:    tx.TxID,
		Status:  "pending",
		Inputs:  []TxInput{},
		Outputs: []TxOutput{},
	}
	if detail.TxID == "" {
		detail.TxID = hash
	}

	if tx.Status.Confirmed {
		detail.Status = "confirmed"
		detail.Confirmations = 1 // Esplora does not return a confirmation count
		if tx.Status.BlockHeight > 0 {
			h := tx.Status.BlockHeight
			detail.BlockHeight = &h
		}
		if tx.Status.BlockTime > 0 {
			t := time.Unix(tx.Status.BlockTime, 0).UTC().Format(time.RFC3339)
			detail.BlockTime = &t
		}
	}

	var outputTotal int64
	for _, vout := range tx.Vout {
		outputTotal += vout.Value
		detail.Outputs = append(detail.Outputs, TxOutput{
			Address: optionalString(vout.ScriptpubkeyAddress),
			Value:   strconv.FormatInt(vout.Value, 10),
		})
	}
	detail.Value = strconv.FormatInt(outputTotal, 10)

	var inputTotal int64
	inputsKnown := true
	for _, vin := range tx.Vin {
		inp := TxInput{Value: "0"}
		if vin.Prevout != nil {
			inputTotal += vin.Prevout.Value
			inp.Value = strconv.FormatInt(vin.Prevout.Value, 10)
			inp.Address = optionalString(vin.Prevout.ScriptpubkeyAddress)
		} else {
			inputsKnown = false
		}
		detail.Inputs = append(detail.Inputs, inp)
	}

	if inputsKnown && inputTotal > outputTotal {
		fee := strconv.FormatInt(inputTotal-outputTotal, 10)
		detail.Fee = &fee
	} else if tx.Fee > 0 {
		// Esplora provides the fee directly even when prevout data is absent.
		fee := strconv.FormatInt(tx.Fee, 10)
		detail.Fee = &fee
	}

	return detail, nil
}

// Broadcast relays a signed transaction to Esplora.
func (s *Service) Broadcast(ctx context.Context, rawHex string) (string, error) {
	raw, err := normalizeRawHex(rawHex)
	if err != nil {
		return "", err
	}
	txid, err := s.esplora.BroadcastTx(ctx, raw)
	if err != nil {
		if errors.Is(err, ErrInvalidTx) {
			return "", ErrInvalidTx
		}
		return "", fmt.Errorf("btc: broadcast: %w", err)
	}
	return txid, nil
}

// normalizeRawHex validates the broadcast payload: hex, even length,
// non-empty and not absurdly large.
func normalizeRawHex(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		s = s[2:]
	}
	if s == "" {
		return "", fmt.Errorf("%w: empty payload", ErrInvalidTx)
	}
	if len(s) > maxRawHexLen {
		return "", fmt.Errorf("%w: payload too large", ErrInvalidTx)
	}
	if len(s)%2 != 0 {
		return "", fmt.Errorf("%w: payload has an odd number of hex characters", ErrInvalidTx)
	}
	for i := 0; i < len(s); i++ {
		if !isHexDigit(s[i]) {
			return "", fmt.Errorf("%w: payload is not hex", ErrInvalidTx)
		}
	}
	return s, nil
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// optionalString returns nil for an empty string.
func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

// encodeCursor encodes a txid into an opaque base64url cursor.
func encodeCursor(txid string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(txid))
}

// decodeCursor decodes a base64url cursor back to a txid.
// Returns an empty string for a blank or malformed cursor (first page).
func decodeCursor(c string) string {
	if c == "" {
		return ""
	}
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return ""
	}
	return string(b)
}
