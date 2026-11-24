package memory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

func cpBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	return append([]byte(nil), b...)
}

func cpKeygen(kg *store.KeyGeneration) *store.KeyGeneration {
	c := *kg
	c.Fingerprint = cpBytes(kg.Fingerprint)
	c.DealerSignature = cpBytes(kg.DealerSignature)
	return &c
}

func cpParts(ps []*store.KeygenParticipant) []*store.KeygenParticipant {
	out := make([]*store.KeygenParticipant, len(ps))
	for i, p := range ps {
		c := *p
		c.EncryptionKey = cpBytes(p.EncryptionKey)
		c.KeySignature = cpBytes(p.KeySignature)
		c.EnvelopeEnc = cpBytes(p.EnvelopeEnc)
		c.EnvelopeCT = cpBytes(p.EnvelopeCT)
		c.EnvelopeHash = cpBytes(p.EnvelopeHash)
		c.EnvelopeFingerprint = cpBytes(p.EnvelopeFingerprint)
		c.AckSignature = cpBytes(p.AckSignature)
		out[i] = &c
	}
	return out
}

func (s *sharedStore) failKeygenLocked(kg *store.KeyGeneration, reason string, now time.Time) {
	kg.Status = store.KeygenFailed
	kg.FailureReason = reason
	t := now
	kg.EndedAt = &t
	for _, p := range s.keygenParts[kg.ID] {
		p.EnvelopeEnc, p.EnvelopeCT = nil, nil
	}
}

// openKeygenLocked returns the ceremony if it is in status want and unexpired;
// an expired open ceremony is failed on the spot.
func (s *sharedStore) openKeygenLocked(id uuid.UUID, want store.KeygenStatus, now time.Time) (*store.KeyGeneration, error) {
	kg, ok := s.keygens[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	if kg.Status.Open() && !now.Before(kg.ExpiresAt) {
		s.failKeygenLocked(kg, store.KeygenFailExpired, now)
	}
	if kg.Status != want {
		return nil, store.ErrKeygenClosed
	}
	return kg, nil
}

func (s *sharedStore) partLocked(keygenID, memberID uuid.UUID) *store.KeygenParticipant {
	for _, p := range s.keygenParts[keygenID] {
		if p.MemberID == memberID {
			return p
		}
	}
	return nil
}

func (s *sharedStore) CreateKeyGeneration(_ context.Context, kg *store.KeyGeneration, parts []*store.KeygenParticipant) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.wallets[kg.WalletID]
	if !ok {
		return store.ErrNotFound
	}
	if w.MembershipVersion != kg.MembershipVersion {
		return store.ErrStale
	}
	if w.KeyStatus == store.KeyActive {
		return store.ErrConflict
	}
	for _, other := range s.keygens {
		if other.WalletID == kg.WalletID && other.Status.Open() {
			if !kg.CreatedAt.Before(other.ExpiresAt) {
				s.failKeygenLocked(other, store.KeygenFailExpired, kg.CreatedAt)
				continue
			}
			return store.ErrConflict
		}
	}
	s.keygens[kg.ID] = cpKeygen(kg)
	s.keygenParts[kg.ID] = cpParts(parts)
	return nil
}

func (s *sharedStore) GetKeyGeneration(_ context.Context, id uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kg, ok := s.keygens[id]
	if !ok {
		return nil, nil, store.ErrNotFound
	}
	return cpKeygen(kg), cpParts(s.keygenParts[id]), nil
}

func (s *sharedStore) LatestKeyGeneration(_ context.Context, walletID uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest *store.KeyGeneration
	for _, kg := range s.keygens {
		if kg.WalletID == walletID && (latest == nil || kg.CreatedAt.After(latest.CreatedAt) ||
			(kg.CreatedAt.Equal(latest.CreatedAt) && kg.ID.String() > latest.ID.String())) {
			latest = kg
		}
	}
	if latest == nil {
		return nil, nil, store.ErrNotFound
	}
	return cpKeygen(latest), cpParts(s.keygenParts[latest.ID]), nil
}

func (s *sharedStore) RegisterEncryptionKey(_ context.Context, keygenID, memberID uuid.UUID, key, sig []byte, now time.Time) (*store.KeyGeneration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kg, err := s.openKeygenLocked(keygenID, store.KeygenCollectingKeys, now)
	if err != nil {
		return nil, err
	}
	p := s.partLocked(keygenID, memberID)
	if p == nil {
		return nil, store.ErrNotEligible
	}
	if p.KeyRegisteredAt != nil {
		return nil, store.ErrConflict
	}
	t := now
	p.EncryptionKey, p.KeySignature, p.KeyRegisteredAt = cpBytes(key), cpBytes(sig), &t
	for _, q := range s.keygenParts[keygenID] {
		if q.KeyRegisteredAt == nil {
			return cpKeygen(kg), nil
		}
	}
	kg.Status = store.KeygenDealing
	return cpKeygen(kg), nil
}

func (s *sharedStore) StageEnvelope(_ context.Context, keygenID, memberID uuid.UUID, fingerprint, enc, ct []byte, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.openKeygenLocked(keygenID, store.KeygenDealing, now); err != nil {
		return err
	}
	p := s.partLocked(keygenID, memberID)
	if p == nil {
		return store.ErrNotEligible
	}
	h := sha256.Sum256(append(cpBytes(enc), ct...))
	p.EnvelopeEnc, p.EnvelopeCT, p.EnvelopeHash, p.EnvelopeFingerprint = cpBytes(enc), cpBytes(ct), h[:], cpBytes(fingerprint)
	return nil
}

func (s *sharedStore) CommitDeal(_ context.Context, keygenID uuid.UUID, fingerprint, dealerSig []byte, now time.Time) (*store.KeyGeneration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kg, err := s.openKeygenLocked(keygenID, store.KeygenDealing, now)
	if err != nil {
		return nil, err
	}
	for _, p := range s.keygenParts[keygenID] {
		if p.EnvelopeCT == nil || !bytes.Equal(p.EnvelopeFingerprint, fingerprint) {
			return nil, store.ErrKeygenIncomplete
		}
	}
	kg.Fingerprint, kg.DealerSignature = cpBytes(fingerprint), cpBytes(dealerSig)
	kg.Status = store.KeygenAwaitingProvisioning
	return cpKeygen(kg), nil
}

func (s *sharedStore) AckProvisioning(_ context.Context, keygenID, memberID uuid.UUID, fingerprint, sig []byte, now time.Time) (*store.KeyGeneration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kg, ok := s.keygens[keygenID]
	if !ok {
		return nil, store.ErrNotFound
	}
	p := s.partLocked(keygenID, memberID)
	if p == nil {
		return nil, store.ErrNotEligible
	}
	if p.ProvisionedAt != nil {
		return nil, store.ErrConflict
	}
	if _, err := s.openKeygenLocked(keygenID, store.KeygenAwaitingProvisioning, now); err != nil {
		return nil, err
	}
	if !bytes.Equal(kg.Fingerprint, fingerprint) {
		return nil, store.ErrMismatch
	}
	t := now
	p.AckSignature, p.ProvisionedAt = cpBytes(sig), &t
	p.EnvelopeEnc, p.EnvelopeCT = nil, nil
	for _, q := range s.keygenParts[keygenID] {
		if q.ProvisionedAt == nil {
			return cpKeygen(kg), nil
		}
	}
	w := s.wallets[kg.WalletID]
	if w.MembershipVersion != kg.MembershipVersion {
		// Unreachable: a membership change fails the open ceremony first.
		s.failKeygenLocked(kg, store.KeygenFailMembershipChanged, now)
		return nil, store.ErrStale
	}
	kg.Status = store.KeygenComplete
	kg.EndedAt = &t
	id := kg.ID
	w.KeyStatus, w.KeyGenerationID, w.KeyFingerprint = store.KeyActive, &id, cpBytes(kg.Fingerprint)
	return cpKeygen(kg), nil
}

func (s *sharedStore) FailKeyGeneration(_ context.Context, keygenID uuid.UUID, reason string, now time.Time) (*store.KeyGeneration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kg, ok := s.keygens[keygenID]
	if !ok {
		return nil, store.ErrNotFound
	}
	if !kg.Status.Open() {
		return nil, store.ErrKeygenClosed
	}
	s.failKeygenLocked(kg, reason, now)
	return cpKeygen(kg), nil
}
