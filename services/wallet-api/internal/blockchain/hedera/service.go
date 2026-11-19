package hedera

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const tinybarsPerHbar = int64(100_000_000)

// A newly created account can be accepted by the network before the Mirror
// Node has indexed it. Ownership verification therefore treats a 404 as
// "not visible yet" for a short, bounded window before concluding the account
// does not exist.
const (
	defaultVerifyAttempts  = 4
	defaultVerifyRetryWait = 750 * time.Millisecond
)

// AccountBalance is the result of a balance lookup.
type AccountBalance struct {
	AccountID   string `json:"accountId"`
	Tinybars    int64  `json:"tinybars"`
	HbarDisplay string `json:"hbar"`
}

// TransactionHistoryPage is one page of Hedera activity for an account.
// NextCursor is an opaque string the client passes back as ?cursor= to fetch
// the next (older) page; it is omitted (nil) when there is no next page.
type TransactionHistoryPage struct {
	Items      []HederaActivityItem `json:"items"`
	NextCursor *string              `json:"nextCursor,omitempty"`
}

// HederaActivityItem is a single activity entry derived from a Mirror Node
// CRYPTOTRANSFER transaction. Amounts are in tinybars (1 HBAR = 100_000_000
// tinybars); HbarDisplay truncates, never rounds.
type HederaActivityItem struct {
	TransactionID  string `json:"transactionId"`
	Timestamp      string `json:"timestamp"`
	Type           string `json:"type"`
	Direction      string `json:"direction"`
	From           string `json:"from"`
	To             string `json:"to"`
	AmountTinybars int64  `json:"amountTinybars"`
	HbarDisplay    string `json:"hbar"`
	FeeTinybars    int64  `json:"feeTinybars"`
	Status         string `json:"status"`
	NetworkID      string `json:"networkId"`
}

// Service implements Hedera business logic.
type Service struct {
	mirror *Mirror

	verifyAttempts  int
	verifyRetryWait time.Duration
}

// NewService builds a Hedera service backed by the given Mirror client.
func NewService(mirror *Mirror) *Service {
	return &Service{
		mirror:          mirror,
		verifyAttempts:  defaultVerifyAttempts,
		verifyRetryWait: defaultVerifyRetryWait,
	}
}

// newServiceWithRetry is used by tests to shorten the visibility-retry window.
func newServiceWithRetry(mirror *Mirror, attempts int, wait time.Duration) *Service {
	if attempts < 1 {
		attempts = 1
	}
	if wait < 0 {
		wait = 0
	}
	return &Service{mirror: mirror, verifyAttempts: attempts, verifyRetryWait: wait}
}

// GetAccountBalance fetches the HBAR balance for accountId.
// The HbarDisplay field is formatted as "X.XXXXXXXX HBAR" (always 8 decimal
// places, truncated — never rounded).
func (s *Service) GetAccountBalance(ctx context.Context, accountID string) (*AccountBalance, error) {
	acct, err := s.mirror.GetAccount(ctx, accountID)
	if err != nil {
		return nil, err
	}
	tb := acct.Balance.Balance
	hbar := tb / tinybarsPerHbar
	frac := tb % tinybarsPerHbar
	if frac < 0 {
		frac = -frac
	}
	display := fmt.Sprintf("%d.%08d HBAR", hbar, frac)
	return &AccountBalance{
		AccountID:   acct.Account,
		Tinybars:    tb,
		HbarDisplay: display,
	}, nil
}

// VerifyAccountOwnership checks that hexPubKey controls accountId on the
// Mirror Node.
//
//   - Returns ErrAccountNotFound if the account does not exist. A 404 is
//     retried briefly first, because a just-created account may not be indexed
//     by the Mirror Node yet.
//   - Returns ErrKeyTypeMismatch if the account's key type is not ECDSA_SECP256K1.
//   - Returns ErrPublicKeyMismatch if the keys do not match (after lowercasing).
func (s *Service) VerifyAccountOwnership(ctx context.Context, accountID, hexPubKey string) error {
	acct, err := s.getAccountRetryingVisibility(ctx, accountID)
	if err != nil {
		return err
	}
	if acct.Key.Type != "ECDSA_SECP256K1" {
		return fmt.Errorf("%w: got %q", ErrKeyTypeMismatch, acct.Key.Type)
	}
	if strings.ToLower(acct.Key.Key) != strings.ToLower(hexPubKey) {
		return ErrPublicKeyMismatch
	}
	return nil
}

// getAccountRetryingVisibility fetches an account, retrying only when the
// Mirror Node answers 404 (not indexed yet). A valid account, a malformed
// Account ID, or an upstream failure is returned immediately — retrying those
// cannot change the outcome.
func (s *Service) getAccountRetryingVisibility(ctx context.Context, accountID string) (*MirrorAccount, error) {
	attempts := s.verifyAttempts
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		acct, err := s.mirror.GetAccount(ctx, accountID)
		if err == nil {
			return acct, nil
		}
		if !errors.Is(err, ErrAccountNotFound) {
			return nil, err
		}
		lastErr = err
		if attempt == attempts-1 {
			break
		}
		timer := time.NewTimer(s.verifyRetryWait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

// feeAccounts are Hedera's network-controlled accounts that receive
// transaction fees as positive transfer legs; they are excluded when
// identifying the human counterparty (the recipient) of a transfer.
//
// Source: docs.hedera.com/learn/core-concepts/accounts/network-accounts
//   - 0.0.98  Network Admin Fee Account (largest share of fees)
//   - 0.0.800 Staking Rewards Account
//   - 0.0.801 Node Rewards Account
//   - 0.0.802 Fee Collection Account (HIP-1259; consolidates all tx fees)
var feeAccounts = map[string]struct{}{
	"0.0.98":  {},
	"0.0.800": {},
	"0.0.801": {},
	"0.0.802": {},
}

// GetTransactionHistory fetches the CRYPTOTRANSFER history for accountId one
// page at a time. Each transaction is classified into an incoming, outgoing,
// or self-transfer relative to accountId; tinybars are converted to an HBAR
// display string using integer (truncating) arithmetic.
func (s *Service) GetTransactionHistory(ctx context.Context, accountID, cursor string) (*TransactionHistoryPage, error) {
	page, err := s.mirror.GetTransactions(ctx, accountID, cursor)
	if err != nil {
		return nil, err
	}

	items := make([]HederaActivityItem, 0, len(page.Transactions))
	for _, tx := range page.Transactions {
		items = append(items, toActivityItem(tx, accountID))
	}

	out := &TransactionHistoryPage{Items: items}
	if page.Links.Next != nil && *page.Links.Next != "" {
		if c, ok := extractCursor(*page.Links.Next); ok {
			cc := c
			out.NextCursor = &cc
		}
	}
	return out, nil
}

// toActivityItem converts a Mirror Node transaction into a wallet activity
// item relative to accountID.
func toActivityItem(tx MirrorTransaction, accountID string) HederaActivityItem {
	direction, amount, from, to := classifyTransfers(tx.Transfers, accountID)

	hbar := amount / tinybarsPerHbar
	frac := amount % tinybarsPerHbar
	if frac < 0 {
		frac = -frac
	}

	status := "failed"
	if tx.Result == "SUCCESS" {
		status = "confirmed"
	}

	return HederaActivityItem{
		TransactionID:  tx.TransactionID,
		Timestamp:      parseConsensusTimestamp(tx.ConsensusTimestamp),
		Type:           tx.Name,
		Direction:      direction,
		From:           from,
		To:             to,
		AmountTinybars: amount,
		HbarDisplay:    fmt.Sprintf("%d.%08d HBAR", hbar, frac),
		FeeTinybars:    tx.Charged_tx_fee,
		Status:         status,
		NetworkID:      "hedera-testnet",
	}
}

// classifyTransfers derives the direction, net amount, and counterparty
// accounts of a transaction relative to accountID.
//
//   - direction is "in" when accountID only receives (positive legs),
//     "out" when it only sends (negative legs), "self" when it both sends and
//     receives, or when it is not present in the transfers at all.
//   - amount is the sum of positive legs ("in"), the sum of the absolute value
//     of negative legs ("out"), or zero ("self").
//   - from is the debited account and to is the credited (non-fee) account.
func classifyTransfers(transfers []MirrorTransfer, accountID string) (direction string, amount int64, from, to string) {
	var posSum, negSum int64
	var hasPos, hasNeg bool
	var firstNeg, firstPos string

	for _, t := range transfers {
		if t.Account == accountID {
			switch {
			case t.Amount > 0:
				posSum += t.Amount
				hasPos = true
			case t.Amount < 0:
				negSum += t.Amount // negative
				hasNeg = true
			}
		}
		if t.Amount < 0 && firstNeg == "" {
			firstNeg = t.Account
		}
		if t.Amount > 0 && firstPos == "" {
			if _, fee := feeAccounts[t.Account]; !fee {
				firstPos = t.Account
			}
		}
	}

	switch {
	case hasPos && hasNeg:
		direction = "self"
		amount = 0
	case hasPos:
		direction = "in"
		amount = posSum
	case hasNeg:
		direction = "out"
		amount = -negSum // absolute value of debits
	default:
		// accountID is not in any leg; treat as a no-op self transfer.
		direction = "self"
		amount = 0
	}

	switch direction {
	case "out":
		from = accountID
		to = firstPos
	case "in":
		from = firstNeg
		to = accountID
	default: // "self"
		from = accountID
		to = accountID
	}
	return direction, amount, from, to
}

// parseConsensusTimestamp converts a Mirror Node consensus timestamp of the
// form "<unixSeconds>.<nanoseconds>" (e.g. "1700000000.123456789") into an
// RFC3339 string in UTC. It returns the raw input unchanged if it cannot be
// parsed.
func parseConsensusTimestamp(ts string) string {
	parts := strings.SplitN(ts, ".", 2)
	sec, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return ts
	}
	var nsec int64
	if len(parts) == 2 {
		nanoStr := parts[1]
		if len(nanoStr) > 9 {
			nanoStr = nanoStr[:9]
		}
		for len(nanoStr) < 9 {
			nanoStr += "0"
		}
		nsec, _ = strconv.ParseInt(nanoStr, 10, 64)
	}
	return time.Unix(sec, nsec).UTC().Format(time.RFC3339)
}

// extractCursor pulls the opaque pagination cursor out of a Mirror Node "next"
// link. The next link carries the page boundary as timestamp=lt:<value>; the
// returned cursor is <value> so that re-feeding it appends &timestamp=lt:<value>
// again. ok is false when the link carries no usable cursor.
func extractCursor(nextLink string) (string, bool) {
	u, err := url.Parse(nextLink)
	if err != nil {
		return "", false
	}
	ts := u.Query().Get("timestamp")
	if ts == "" {
		return "", false
	}
	if strings.HasPrefix(ts, "lt:") {
		ts = strings.TrimPrefix(ts, "lt:")
	}
	if ts == "" {
		return "", false
	}
	return ts, true
}
