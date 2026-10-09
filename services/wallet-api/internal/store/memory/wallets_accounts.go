package memory

import (
	"context"
	"sync"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type walletStore struct {
	mu   sync.RWMutex
	data map[string]*store.Wallet
}

func (s *walletStore) Create(ctx context.Context, w *store.Wallet) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *w
	s.data[w.ID.String()] = &cp
	return nil
}

func (s *walletStore) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Wallet, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Wallet
	for _, w := range s.data {
		if w.UserID == userID {
			cp := *w
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *walletStore) Get(ctx context.Context, userID, walletID uuid.UUID) (*store.Wallet, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	w, ok := s.data[walletID.String()]
	if !ok || w.UserID != userID {
		return nil, store.ErrNotFound
	}
	cp := *w
	return &cp, nil
}

type accountStore struct {
	mu   sync.RWMutex
	data map[string]*store.Account
}

func (s *accountStore) Create(ctx context.Context, a *store.Account) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data {
		if existing.WalletID == a.WalletID && existing.HDIndex != nil && a.HDIndex != nil && *existing.HDIndex == *a.HDIndex {
			return store.ErrConflict
		}
	}
	cp := *a
	s.data[a.ID.String()] = &cp
	return nil
}

func (s *accountStore) Get(ctx context.Context, userID, accountID uuid.UUID) (*store.Account, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.data[accountID.String()]
	if !ok || a.UserID != userID {
		return nil, store.ErrNotFound
	}
	cp := *a
	return &cp, nil
}

func (s *accountStore) ListByWallet(ctx context.Context, userID, walletID uuid.UUID) ([]*store.Account, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Account
	for _, a := range s.data {
		if a.UserID == userID && a.WalletID == walletID {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *accountStore) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Account, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Account
	for _, a := range s.data {
		if a.UserID == userID {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *accountStore) Update(ctx context.Context, userID, accountID uuid.UUID, name *string, hidden *bool) (*store.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.data[accountID.String()]
	if !ok || a.UserID != userID {
		return nil, store.ErrNotFound
	}
	if name != nil {
		a.Name = *name
	}
	if hidden != nil {
		a.Hidden = *hidden
	}
	cp := *a
	return &cp, nil
}

type addressStore struct {
	mu   sync.RWMutex
	data map[string]*store.Address
}

func (s *addressStore) Create(ctx context.Context, a *store.Address) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data {
		if existing.AccountID == a.AccountID && existing.NetworkFamily == a.NetworkFamily && existing.Address == a.Address {
			return store.ErrConflict
		}
	}
	cp := *a
	s.data[a.ID.String()] = &cp
	return nil
}

func (s *addressStore) ListByAccount(ctx context.Context, userID, accountID uuid.UUID) ([]*store.Address, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Address
	for _, a := range s.data {
		if a.AccountID == accountID {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *addressStore) ListByAccounts(ctx context.Context, userID uuid.UUID, accountIDs []uuid.UUID) ([]*store.Address, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	set := make(map[uuid.UUID]struct{}, len(accountIDs))
	for _, id := range accountIDs {
		set[id] = struct{}{}
	}
	var out []*store.Address
	for _, a := range s.data {
		if _, ok := set[a.AccountID]; ok {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}
