package memory

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

type challengeStore struct {
	mu   sync.Mutex
	data map[string]*store.Challenge
}

func (s *challengeStore) Create(ctx context.Context, c *store.Challenge) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *c
	s.data[c.ID.String()] = &cp
	return nil
}

func (s *challengeStore) Get(ctx context.Context, id uuid.UUID) (*store.Challenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[id.String()]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *c
	return &cp, nil
}

// ClaimChallenge is atomic under s.mu: the existence check, used_at check,
// and set all happen while holding the single lock.
func (s *challengeStore) ClaimChallenge(ctx context.Context, id uuid.UUID) (*store.Challenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[id.String()]
	if !ok {
		return nil, store.ErrNotFound
	}
	if c.UsedAt != nil {
		return nil, store.ErrConflict
	}
	now := time.Now().UTC()
	c.UsedAt = &now
	cp := *c
	return &cp, nil
}

type sessionStore struct {
	mu   sync.Mutex
	data map[string]*store.Session
}

func (s *sessionStore) Create(ctx context.Context, sess *store.Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *sess
	s.data[sess.ID.String()] = &cp
	return nil
}

func (s *sessionStore) Get(ctx context.Context, id uuid.UUID) (*store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.data[id.String()]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *sess
	return &cp, nil
}

func (s *sessionStore) ExtendExpiry(ctx context.Context, sessionID uuid.UUID, newExpiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.data[sessionID.String()]
	if !ok {
		return store.ErrNotFound
	}
	sess.ExpiresAt = newExpiresAt
	return nil
}

func (s *sessionStore) Revoke(ctx context.Context, sessionID uuid.UUID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.data[sessionID.String()]
	if !ok {
		return store.ErrNotFound
	}
	now := time.Now().UTC()
	sess.RevokedAt = &now
	return nil
}

func (s *sessionStore) RevokeByDevice(ctx context.Context, deviceID uuid.UUID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for _, sess := range s.data {
		if sess.DeviceID == deviceID {
			sess.RevokedAt = &now
		}
	}
	return nil
}
