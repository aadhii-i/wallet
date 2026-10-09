package transaction

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// ErrFromAddressNotRegistered is returned when the caller asks to track a
// transaction whose "from" address is not one of the account's own
// registered addresses. Without this check, any authenticated user could
// register an arbitrary victim address as the sender on their own account
// and pollute/confuse that account's tracked history.
var ErrFromAddressNotRegistered = errors.New("transaction: from address is not registered to this account")

type Service struct {
	store store.Store
}

func NewService(st store.Store) *Service {
	return &Service{store: st}
}

type CreateInput struct {
	NetworkID string
	Hash      string
	AccountID uuid.UUID
	From      string
	To        string
	AssetID   string
	Amount    string
	Nonce     *int64
}

// Create registers a transaction for tracking. It is idempotent on
// (networkId, hash): a repeat call for the same pair returns the existing
// row rather than creating a duplicate or erroring.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, in CreateInput) (*store.Transaction, error) {
	if existing, err := s.store.Transactions().GetByNetworkAndHash(ctx, userID, in.NetworkID, in.Hash); err == nil {
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	if _, err := s.store.Accounts().Get(ctx, userID, in.AccountID); err != nil {
		return nil, err
	}

	addresses, err := s.store.Addresses().ListByAccount(ctx, userID, in.AccountID)
	if err != nil {
		return nil, err
	}
	fromRegistered := false
	for _, a := range addresses {
		if strings.EqualFold(a.Address, in.From) {
			fromRegistered = true
			break
		}
	}
	if !fromRegistered {
		return nil, ErrFromAddressNotRegistered
	}

	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	now := time.Now().UTC()
	tx := &store.Transaction{
		ID:        id,
		UserID:    userID,
		AccountID: in.AccountID,
		NetworkID: in.NetworkID,
		Hash:      in.Hash,
		From:      in.From,
		To:        in.To,
		AssetID:   in.AssetID,
		Amount:    in.Amount,
		Nonce:     in.Nonce,
		Status:    store.TxPending,
		Origin:    store.OriginWallet,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.store.Transactions().Create(ctx, tx); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return s.store.Transactions().GetByNetworkAndHash(ctx, userID, in.NetworkID, in.Hash)
		}
		return nil, err
	}
	return tx, nil
}

func (s *Service) Get(ctx context.Context, userID, id uuid.UUID) (*store.Transaction, []*store.TransactionEvent, error) {
	tx, err := s.store.Transactions().Get(ctx, userID, id)
	if err != nil {
		return nil, nil, err
	}
	events, err := s.store.Transactions().ListEvents(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	return tx, events, nil
}
