// Package hedera implements wallet-api's Hedera Hashgraph support using the
// Hedera Testnet Mirror Node REST API as the data source.
//
// Security invariants:
//   - Hedera Account IDs are never logged in plaintext; a sha256 fingerprint
//     (first 8 hex chars) is used in all error and log strings.
//   - The server never holds or receives spending keys.
package hedera

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	mirrorDefaultBaseURL = "https://testnet.mirrornode.hedera.com/api/v1"
	mirrorTimeout        = 15 * time.Second
	mirrorMaxBytes       = 1 << 20 // 1 MiB
)

// accountIDRe validates the shard.realm.num format.
var accountIDRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// Sentinel errors returned by the mirror client and service.
var (
	ErrAccountNotFound   = errors.New("hedera: account not found")
	ErrInvalidAccountID  = errors.New("hedera: invalid account id format")
	ErrKeyTypeMismatch   = errors.New("hedera: account key type is not ECDSA_SECP256K1")
	ErrPublicKeyMismatch = errors.New("hedera: public key does not match account")
)

// MirrorBalance is the balance sub-object returned by the Mirror Node.
type MirrorBalance struct {
	Balance   int64  `json:"balance"`
	Timestamp string `json:"timestamp"`
}

// MirrorKey is the key sub-object returned by the Mirror Node.
// The JSON field name is "_type" (underscore prefix) per the Mirror Node API.
type MirrorKey struct {
	Type string `json:"_type"`
	Key  string `json:"key"`
}

// MirrorAccount is the account object returned by GET /accounts/{accountId}.
type MirrorAccount struct {
	Account                   string        `json:"account"`
	Balance                   MirrorBalance `json:"balance"`
	Key                       MirrorKey     `json:"key"`
	Deleted                   *bool         `json:"deleted"`
	ReceiverSignatureRequired *bool         `json:"receiver_sig_required"`
}

// MirrorLinks holds the pagination links returned by the Mirror Node. Next is
// a relative URL pointing at the previous (older) page, or nil when there are
// no more results.
type MirrorLinks struct {
	Next *string `json:"next"` // may be null
}

// MirrorTransfer is a single credit/debit leg of a transaction. Amount is in
// tinybars; a negative value is a debit from Account, positive is a credit.
type MirrorTransfer struct {
	Account string `json:"account"`
	Amount  int64  `json:"amount"`
}

// MirrorTransaction is a transaction object returned by GET /transactions.
// Charged_tx_fee mirrors the Mirror Node field name (snake_case) on purpose.
type MirrorTransaction struct {
	TransactionID      string           `json:"transaction_id"`
	Name               string           `json:"name"`
	ConsensusTimestamp string           `json:"consensus_timestamp"`
	Result             string           `json:"result"`
	Charged_tx_fee     int64            `json:"charged_tx_fee"`
	Transfers          []MirrorTransfer `json:"transfers"`
	MemoBase64         string           `json:"memo_base64"`
	EntityID           string           `json:"entity_id"`
}

// MirrorTransactionPage is the page returned by GET /transactions.
type MirrorTransactionPage struct {
	Transactions []MirrorTransaction `json:"transactions"`
	Links        MirrorLinks         `json:"links"`
}

// MirrorConfig configures the Mirror Node HTTP client.
type MirrorConfig struct {
	// BaseURL is the Mirror Node API root (no trailing slash).
	// Defaults to https://testnet.mirrornode.hedera.com/api/v1 when empty.
	BaseURL string
}

// Mirror is an HTTP client for the Hedera Mirror Node REST API.
type Mirror struct {
	base   string
	client *http.Client
}

// NewMirror builds a Mirror client. If cfg.BaseURL is empty the public
// Hedera Testnet Mirror Node is used.
func NewMirror(cfg MirrorConfig) *Mirror {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		base = mirrorDefaultBaseURL
	}
	return &Mirror{
		base:   base,
		client: &http.Client{Timeout: mirrorTimeout},
	}
}

// accountFingerprint returns the first 8 hex characters of sha256(accountId).
// Never log or return the raw account ID.
func accountFingerprint(accountID string) string {
	h := sha256.Sum256([]byte(accountID))
	return fmt.Sprintf("%x", h[:4]) // 4 bytes = 8 hex chars
}

// GetAccount fetches account information from the Mirror Node.
// accountId must be in shard.realm.num format (e.g. "0.0.12345").
func (m *Mirror) GetAccount(ctx context.Context, accountID string) (*MirrorAccount, error) {
	if !accountIDRe.MatchString(accountID) {
		return nil, fmt.Errorf("%w: fingerprint=%s", ErrInvalidAccountID, accountFingerprint(accountID))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.base+"/accounts/"+accountID, nil)
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: get account fingerprint=%s: %w", accountFingerprint(accountID), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, mirrorMaxBytes))
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: read body fingerprint=%s: %w", accountFingerprint(accountID), err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: fingerprint=%s", ErrAccountNotFound, accountFingerprint(accountID))
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hedera/mirror: get account fingerprint=%s: status %d", accountFingerprint(accountID), resp.StatusCode)
	}

	var out MirrorAccount
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("hedera/mirror: decode account fingerprint=%s: %w", accountFingerprint(accountID), err)
	}
	return &out, nil
}

// GetTransactions fetches the CRYPTOTRANSFER transactions for accountId, newest
// first, up to 25 per page. When cursor is non-empty it is appended as
// &timestamp=lt:{cursor} to page through older transactions. accountId must be
// in shard.realm.num format.
func (m *Mirror) GetTransactions(ctx context.Context, accountID, cursor string) (*MirrorTransactionPage, error) {
	if !accountIDRe.MatchString(accountID) {
		return nil, fmt.Errorf("%w: fingerprint=%s", ErrInvalidAccountID, accountFingerprint(accountID))
	}

	u := m.base + "/transactions?account.id=" + accountID + "&limit=25&order=desc&type=CRYPTOTRANSFER"
	// The cursor is opaque user input; url.QueryEscape neutralizes '&' and '='
	// so a malicious cursor cannot inject extra query parameters (e.g. rewrite
	// limit or type) into the outbound mirror-node request.
	if cursor != "" {
		u += "&timestamp=lt:" + url.QueryEscape(cursor)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: get transactions fingerprint=%s: %w", accountFingerprint(accountID), err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, mirrorMaxBytes))
	if err != nil {
		return nil, fmt.Errorf("hedera/mirror: read body fingerprint=%s: %w", accountFingerprint(accountID), err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: fingerprint=%s", ErrAccountNotFound, accountFingerprint(accountID))
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hedera/mirror: get transactions fingerprint=%s: status %d", accountFingerprint(accountID), resp.StatusCode)
	}

	var out MirrorTransactionPage
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("hedera/mirror: decode transactions fingerprint=%s: %w", accountFingerprint(accountID), err)
	}
	return &out, nil
}
