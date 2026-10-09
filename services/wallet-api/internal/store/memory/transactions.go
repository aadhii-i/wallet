package memory

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type txStore struct {
	mu     sync.RWMutex
	data   map[string]*store.Transaction
	events map[string][]*store.TransactionEvent
}

func (s *txStore) Create(ctx context.Context, t *store.Transaction) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data {
		// Scoped per-user (matches the (user_id, network_id, hash) unique
		// constraint in the Postgres schema): a different user tracking the
		// same on-chain hash must never conflict with this user's own row.
		if existing.UserID == t.UserID && existing.NetworkID == t.NetworkID && existing.Hash == t.Hash {
			return store.ErrConflict
		}
	}
	cp := *t
	s.data[t.ID.String()] = &cp
	return nil
}

func (s *txStore) GetByNetworkAndHash(ctx context.Context, userID uuid.UUID, networkID, hash string) (*store.Transaction, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, t := range s.data {
		if t.UserID == userID && t.NetworkID == networkID && t.Hash == hash {
			cp := *t
			return &cp, nil
		}
	}
	return nil, store.ErrNotFound
}

func (s *txStore) Get(ctx context.Context, userID, id uuid.UUID) (*store.Transaction, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.data[id.String()]
	if !ok || t.UserID != userID {
		return nil, store.ErrNotFound
	}
	cp := *t
	return &cp, nil
}

func (s *txStore) Update(ctx context.Context, t *store.Transaction) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.data[t.ID.String()]
	if !ok {
		return store.ErrNotFound
	}
	t.UpdatedAt = time.Now().UTC()
	cp := *t
	_ = existing
	s.data[t.ID.String()] = &cp
	return nil
}

func (s *txStore) ListPending(ctx context.Context) ([]*store.Transaction, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Transaction
	for _, t := range s.data {
		if t.Status == store.TxPending {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *txStore) AddEvent(ctx context.Context, e *store.TransactionEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := e.TransactionID.String()
	cp := *e
	s.events[key] = append(s.events[key], &cp)
	return nil
}

func (s *txStore) ListEvents(ctx context.Context, transactionID uuid.UUID) ([]*store.TransactionEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	evs := s.events[transactionID.String()]
	out := make([]*store.TransactionEvent, len(evs))
	copy(out, evs)
	return out, nil
}

func (s *txStore) ListByAccount(ctx context.Context, userID, accountID uuid.UUID, networkID string) ([]*store.Transaction, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Transaction
	for _, t := range s.data {
		if t.UserID == userID && t.AccountID == accountID && (networkID == "" || t.NetworkID == networkID) {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}
