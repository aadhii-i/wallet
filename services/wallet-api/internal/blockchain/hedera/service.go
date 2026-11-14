package hedera

import (
	"context"
	"fmt"
	"strings"
)

const tinybarsPerHbar = int64(100_000_000)

// AccountBalance is the result of a balance lookup.
type AccountBalance struct {
	AccountID   string `json:"accountId"`
	Tinybars    int64  `json:"tinybars"`
	HbarDisplay string `json:"hbar"`
}

// Service implements Hedera business logic.
type Service struct {
	mirror *Mirror
}

// NewService builds a Hedera service backed by the given Mirror client.
func NewService(mirror *Mirror) *Service {
	return &Service{mirror: mirror}
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
//   - Returns ErrAccountNotFound if the account does not exist.
//   - Returns ErrKeyTypeMismatch if the account's key type is not ECDSA_SECP256K1.
//   - Returns ErrPublicKeyMismatch if the keys do not match (after lowercasing).
func (s *Service) VerifyAccountOwnership(ctx context.Context, accountID, hexPubKey string) error {
	acct, err := s.mirror.GetAccount(ctx, accountID)
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
