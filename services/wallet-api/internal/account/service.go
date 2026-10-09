package account

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/audit"
	"github.com/qdwallet/wallet-api/internal/store"
)

var ErrHDIndexTaken = errors.New("account: hd index already used in this wallet")

type Service struct {
	store store.Store
}

func NewService(st store.Store) *Service {
	return &Service{store: st}
}

func (s *Service) CreateWallet(ctx context.Context, userID uuid.UUID, label string) (*store.Wallet, error) {
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	w := &store.Wallet{
		ID:                 id,
		UserID:             userID,
		Label:              label,
		DefaultSigningMode: store.SigningHD,
		CreatedAt:          time.Now().UTC(),
	}
	if err := s.store.Wallets().Create(ctx, w); err != nil {
		return nil, err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "wallet_create", "wallet", w.ID.String(), map[string]any{"label": label})
	return w, nil
}

// ListWalletsWithAccounts returns every wallet owned by userID, each with
// its accounts (and each account's addresses) attached.
func (s *Service) ListWalletsWithAccounts(ctx context.Context, userID uuid.UUID) ([]*store.Wallet, map[uuid.UUID][]*store.Account, map[uuid.UUID][]*store.Address, error) {
	wallets, err := s.store.Wallets().ListByUser(ctx, userID)
	if err != nil {
		return nil, nil, nil, err
	}
	accounts, err := s.store.Accounts().ListByUser(ctx, userID)
	if err != nil {
		return nil, nil, nil, err
	}
	byWallet := map[uuid.UUID][]*store.Account{}
	var accountIDs []uuid.UUID
	for _, a := range accounts {
		byWallet[a.WalletID] = append(byWallet[a.WalletID], a)
		accountIDs = append(accountIDs, a.ID)
	}
	addrs, err := s.store.Addresses().ListByAccounts(ctx, userID, accountIDs)
	if err != nil {
		return nil, nil, nil, err
	}
	byAccount := map[uuid.UUID][]*store.Address{}
	for _, a := range addrs {
		byAccount[a.AccountID] = append(byAccount[a.AccountID], a)
	}
	return wallets, byWallet, byAccount, nil
}

func (s *Service) CreateAccount(ctx context.Context, userID, walletID uuid.UUID, hdIndex int64, name string) (*store.Account, error) {
	if _, err := s.store.Wallets().Get(ctx, userID, walletID); err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	a := &store.Account{
		ID:          id,
		WalletID:    walletID,
		UserID:      userID,
		HDIndex:     &hdIndex,
		Name:        name,
		SigningMode: store.SigningHD,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.store.Accounts().Create(ctx, a); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrHDIndexTaken
		}
		return nil, err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "account_create", "account", a.ID.String(), map[string]any{"hdIndex": hdIndex})
	return a, nil
}

func (s *Service) UpdateAccount(ctx context.Context, userID, accountID uuid.UUID, name *string, hidden *bool) (*store.Account, error) {
	return s.store.Accounts().Update(ctx, userID, accountID, name, hidden)
}

func (s *Service) GetAccount(ctx context.Context, userID, accountID uuid.UUID) (*store.Account, error) {
	return s.store.Accounts().Get(ctx, userID, accountID)
}

func (s *Service) ListAddresses(ctx context.Context, userID, accountID uuid.UUID) ([]*store.Address, error) {
	return s.store.Addresses().ListByAccount(ctx, userID, accountID)
}

// RegisterAddress verifies an EIP-191 ownership proof and stores the
// address against the account. Monero addresses are never accepted here
// (ADR-006 / D2).
func (s *Service) RegisterAddress(ctx context.Context, userID, accountID uuid.UUID, networkFamily, address, proof string) (*store.Address, error) {
	if networkFamily != string(store.FamilyEVM) {
		return nil, fmt.Errorf("account: unsupported networkFamily %q", networkFamily)
	}
	if _, err := s.store.Accounts().Get(ctx, userID, accountID); err != nil {
		return nil, err
	}
	normalized, err := NormalizeAddress(address)
	if err != nil {
		return nil, err
	}
	if err := VerifyAddressProof(accountID.String(), normalized, userID.String(), proof); err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	a := &store.Address{
		ID:            id,
		AccountID:     accountID,
		NetworkFamily: store.FamilyEVM,
		Address:       normalized,
		CreatedAt:     time.Now().UTC(),
	}
	if err := s.store.Addresses().Create(ctx, a); err != nil && !errors.Is(err, store.ErrConflict) {
		return nil, err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "address_register", "address", a.ID.String(), map[string]any{"accountId": accountID.String()})
	return a, nil
}
