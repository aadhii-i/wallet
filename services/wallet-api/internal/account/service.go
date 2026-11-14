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

// HederaAccountVerifier is a minimal interface for verifying that a Hedera
// Account ID is controlled by the given secp256k1 public key.
// Defined here (not in the hedera package) to avoid a direct dependency on
// the hedera package from the account package (dependency inversion).
type HederaAccountVerifier interface {
	VerifyAccountOwnership(ctx context.Context, accountID, hexPubKey string) error
}

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

// RegisterBitcoinAddress verifies a secp256k1 ownership proof and stores the
// Bitcoin address against the account.
//
// network must be "mainnet" or "testnet4".
// addressType must be "p2wpkh" or "p2tr".
// proof must be in the format produced by btcOwnershipProof in wallet-core:
//
//	"0x" + hex(compressedPubKey(33 bytes) || r(32 bytes) || s(32 bytes))
func (s *Service) RegisterBitcoinAddress(ctx context.Context, userID, accountID uuid.UUID, network, addressType, address, proof string) (*store.Address, error) {
	if _, err := s.store.Accounts().Get(ctx, userID, accountID); err != nil {
		return nil, err
	}
	normalized := normalizeBtcAddress(address)
	if err := VerifyBtcAddressProof(accountID.String(), network, normalized, userID.String(), addressType, proof); err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	a := &store.Address{
		ID:            id,
		AccountID:     accountID,
		NetworkFamily: store.FamilyBitcoin,
		Address:       normalized,
		CreatedAt:     time.Now().UTC(),
	}
	if err := s.store.Addresses().Create(ctx, a); err != nil && !errors.Is(err, store.ErrConflict) {
		return nil, err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "btc_address_register", "address", a.ID.String(), map[string]any{"accountId": accountID.String(), "network": network, "addressType": addressType})
	return a, nil
}

// normalizeBtcAddress lowercases a Bitcoin address (bech32/bech32m addresses
// are case-insensitive; lowercase is the canonical form).
func normalizeBtcAddress(address string) string {
	result := make([]byte, len(address))
	for i := 0; i < len(address); i++ {
		c := address[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		result[i] = c
	}
	return string(result)
}

// RegisterHederaAddress verifies that hexPubKey controls hederaAccountID on
// the Mirror Node, then stores the Hedera Account ID as the address.
//
// mirror is the HederaAccountVerifier — typically *hedera.Service, but kept
// as an interface so this package does not import the hedera package.
func (s *Service) RegisterHederaAddress(ctx context.Context, userID, accountID uuid.UUID, hederaAccountID, hexPubKey string, mirror HederaAccountVerifier) (*store.Address, error) {
	if _, err := s.store.Accounts().Get(ctx, userID, accountID); err != nil {
		return nil, err
	}
	if err := mirror.VerifyAccountOwnership(ctx, hederaAccountID, hexPubKey); err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	a := &store.Address{
		ID:            id,
		AccountID:     accountID,
		NetworkFamily: store.FamilyHedera,
		Address:       hederaAccountID,
		CreatedAt:     time.Now().UTC(),
	}
	if err := s.store.Addresses().Create(ctx, a); err != nil && !errors.Is(err, store.ErrConflict) {
		return nil, err
	}
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", userID.String(), "hedera_address_register", "address", a.ID.String(), map[string]any{"accountId": accountID.String()})
	return a, nil
}
