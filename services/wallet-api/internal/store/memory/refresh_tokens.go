package memory

import (
	"context"
	"encoding/base64"
	"sync"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type refreshTokenStore struct {
	mu   sync.Mutex
	data map[string]*store.RefreshToken
}

func newRefreshTokenStore() *refreshTokenStore {
	return &refreshTokenStore{data: map[string]*store.RefreshToken{}}
}

func hashKey(hash []byte) string { return base64.RawURLEncoding.EncodeToString(hash) }

func (s *refreshTokenStore) Create(ctx context.Context, rt *store.RefreshToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *rt
	s.data[hashKey(rt.Hash)] = &cp
	return nil
}

func (s *refreshTokenStore) GetByHash(ctx context.Context, hash []byte) (*store.RefreshToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rt, ok := s.data[hashKey(hash)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *rt
	return &cp, nil
}

// ClaimRotation is atomic under s.mu: the load, rotated-check, and set all
// happen while holding the single lock, so two concurrent callers can never
// both observe rotated=false and both proceed.
func (s *refreshTokenStore) ClaimRotation(ctx context.Context, hash []byte) (uuid.UUID, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rt, ok := s.data[hashKey(hash)]
	if !ok {
		return uuid.UUID{}, false, store.ErrNotFound
	}
	if rt.Rotated {
		return rt.SessionID, false, nil
	}
	rt.Rotated = true
	return rt.SessionID, true, nil
}
