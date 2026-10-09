package memory

import (
	"context"
	"sort"
	"sync"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/audit"
	"github.com/qdwallet/wallet-api/internal/store"
)

type securityEventStore struct {
	mu   sync.RWMutex
	data map[string]*store.SecurityEvent
}

func (s *securityEventStore) Create(ctx context.Context, e *store.SecurityEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *e
	s.data[e.ID.String()] = &cp
	return nil
}

func (s *securityEventStore) ListByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*store.SecurityEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.SecurityEvent
	for _, e := range s.data {
		if e.UserID == userID {
			cp := *e
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

type auditStore struct {
	mu      sync.Mutex
	entries []*store.AuditLog
}

func (s *auditStore) Append(ctx context.Context, entry *store.AuditLog) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var prevHash []byte
	if len(s.entries) > 0 {
		prevHash = s.entries[len(s.entries)-1].RowHash
	}
	entry.ID = int64(len(s.entries) + 1)
	entry.PrevHash = prevHash
	hash, err := audit.RowHash(prevHash, entry)
	if err != nil {
		return err
	}
	entry.RowHash = hash
	cp := *entry
	s.entries = append(s.entries, &cp)
	return nil
}

func (s *auditStore) List(ctx context.Context, limit int) ([]*store.AuditLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*store.AuditLog, len(s.entries))
	copy(out, s.entries)
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (s *auditStore) VerifyChain(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return audit.VerifyChain(s.entries)
}

type idempotencyStore struct {
	mu   sync.Mutex
	data map[string]*store.IdempotencyRecord
}

func idemKey(userID uuid.UUID, key, route string) string {
	return userID.String() + "|" + route + "|" + key
}

func (s *idempotencyStore) Get(ctx context.Context, userID uuid.UUID, key, route string) (*store.IdempotencyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.data[idemKey(userID, key, route)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *rec
	return &cp, nil
}

func (s *idempotencyStore) Put(ctx context.Context, rec *store.IdempotencyRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *rec
	s.data[idemKey(rec.UserID, rec.Key, rec.Route)] = &cp
	return nil
}
