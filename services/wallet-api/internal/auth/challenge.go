package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

const ChallengeTTL = 60 * time.Second

const MobileOrigin = "app:qdwallet"

var (
	ErrChallengeNotFound    = errors.New("auth: challenge not found")
	ErrChallengeExpired     = errors.New("auth: challenge expired")
	ErrChallengeUsed        = errors.New("auth: challenge already used")
	ErrChallengeKeyMismatch = errors.New("auth: challenge is bound to a different public key")
)

type ChallengeService struct {
	challenges store.Challenges
}

func NewChallengeService(challenges store.Challenges) *ChallengeService {
	return &ChallengeService{challenges: challenges}
}

// buildMessage constructs the exact auth message string clients must sign.
func buildMessage(origin, challengeID, nonce, issuedAt string) string {
	return fmt.Sprintf("QDWallet-Auth|v1|%s|%s|%s|%s", origin, challengeID, nonce, issuedAt)
}

func randomNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Create issues a new single-use challenge bound to publicKeyDER and the
// resolved origin (the caller resolves origin from X-QD-Client / Origin
// header before calling this).
func (s *ChallengeService) Create(ctx context.Context, publicKeyDER []byte, origin, clientType string) (*store.Challenge, error) {
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	now := time.Now().UTC()
	issuedAt := now.Format(time.RFC3339)
	msg := buildMessage(origin, id.String(), nonce, issuedAt)
	c := &store.Challenge{
		ID:         id,
		PublicKey:  publicKeyDER,
		Nonce:      nonce,
		Message:    msg,
		Origin:     origin,
		ClientType: clientType,
		ExpiresAt:  now.Add(ChallengeTTL),
		CreatedAt:  now,
	}
	if err := s.challenges.Create(ctx, c); err != nil {
		return nil, err
	}
	return c, nil
}

// Consume atomically claims (marks used) a challenge and then validates it,
// so two concurrent redemption attempts for the same challenge can never
// both succeed (the store-level ClaimChallenge does the atomic
// used_at IS NULL -> now() transition; everything here is just validation
// of the row it returns).
func (s *ChallengeService) Consume(ctx context.Context, challengeID uuid.UUID, publicKeyDER []byte) (*store.Challenge, error) {
	c, err := s.challenges.ClaimChallenge(ctx, challengeID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrChallengeNotFound
		}
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrChallengeUsed
		}
		return nil, err
	}
	// The challenge is now consumed regardless of what we find below: an
	// expired or key-mismatched claim can never be retried, which is fine
	// since it was never going to succeed anyway.
	if time.Now().After(c.ExpiresAt) {
		return nil, ErrChallengeExpired
	}
	if string(c.PublicKey) != string(publicKeyDER) {
		return nil, ErrChallengeKeyMismatch
	}
	return c, nil
}
