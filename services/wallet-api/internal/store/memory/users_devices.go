package memory

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type userStore struct {
	mu   sync.RWMutex
	data map[string]*store.User
}

func (s *userStore) Create(ctx context.Context, u *store.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *u
	s.data[u.ID.String()] = &cp
	return nil
}

func (s *userStore) Get(ctx context.Context, id uuid.UUID) (*store.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.data[id.String()]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *u
	return &cp, nil
}

type deviceStore struct {
	mu   sync.RWMutex
	data map[string]*store.Device
}

func (s *deviceStore) Create(ctx context.Context, d *store.Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data {
		if string(existing.PublicKey) == string(d.PublicKey) {
			return store.ErrConflict
		}
	}
	cp := *d
	s.data[d.ID.String()] = &cp
	return nil
}

func (s *deviceStore) GetByPublicKey(ctx context.Context, publicKey []byte) (*store.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, d := range s.data {
		if string(d.PublicKey) == string(publicKey) {
			cp := *d
			return &cp, nil
		}
	}
	return nil, store.ErrNotFound
}

func (s *deviceStore) Get(ctx context.Context, userID, deviceID uuid.UUID) (*store.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.data[deviceID.String()]
	if !ok || d.UserID != userID {
		return nil, store.ErrNotFound
	}
	cp := *d
	return &cp, nil
}

func (s *deviceStore) GetByID(ctx context.Context, deviceID uuid.UUID) (*store.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.data[deviceID.String()]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *d
	return &cp, nil
}

func (s *deviceStore) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*store.Device
	for _, d := range s.data {
		if d.UserID == userID {
			cp := *d
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *deviceStore) UpdateLabel(ctx context.Context, userID, deviceID uuid.UUID, label string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.data[deviceID.String()]
	if !ok || d.UserID != userID {
		return store.ErrNotFound
	}
	d.Label = label
	return nil
}

func (s *deviceStore) Revoke(ctx context.Context, userID, deviceID uuid.UUID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.data[deviceID.String()]
	if !ok || d.UserID != userID {
		return store.ErrNotFound
	}
	now := time.Now().UTC()
	d.RevokedAt = &now
	return nil
}

func (s *deviceStore) TouchLastSeen(ctx context.Context, deviceID uuid.UUID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.data[deviceID.String()]
	if !ok {
		return store.ErrNotFound
	}
	d.LastSeenAt = time.Now().UTC()
	return nil
}
