package auth

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/security"
)

const (
	Issuer         = "wallet-api"
	Audience       = "wallet-api"
	AccessTokenTTL = 10 * time.Minute
	SigningKeyID   = "access-token-signing-key"
)

// AccessClaims are the JWT claims for the access token, per spec §22.
type AccessClaims struct {
	jwt.RegisteredClaims
	DeviceID  string `json:"did"`
	SessionID string `json:"sid"`
}

type TokenIssuer struct {
	km security.KeyManager
}

func NewTokenIssuer(km security.KeyManager) *TokenIssuer {
	return &TokenIssuer{km: km}
}

// IssueAccessToken mints a 10-minute ES256 JWT for the given principal.
func (t *TokenIssuer) IssueAccessToken(ctx context.Context, userID, deviceID, sessionID uuid.UUID) (string, time.Time, error) {
	pk, err := t.km.SigningKey(ctx, SigningKeyID)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: load signing key: %w", err)
	}
	now := time.Now().UTC()
	expiresAt := now.Add(AccessTokenTTL)
	claims := AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    Issuer,
			Audience:  jwt.ClaimStrings{Audience},
			Subject:   userID.String(),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        uuid.NewString(),
		},
		DeviceID:  deviceID.String(),
		SessionID: sessionID.String(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	signed, err := token.SignedString(pk)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("auth: sign access token: %w", err)
	}
	return signed, expiresAt, nil
}

// VerifyAccessToken parses and validates an access token, returning its
// claims. It does not check session revocation; callers must do that
// separately against the session store.
func (t *TokenIssuer) VerifyAccessToken(ctx context.Context, raw string) (*AccessClaims, error) {
	pub, err := t.km.PublicKey(ctx, SigningKeyID)
	if err != nil {
		return nil, fmt.Errorf("auth: load verification key: %w", err)
	}
	ecPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("auth: signing key is not ECDSA")
	}
	claims := &AccessClaims{}
	parsed, err := jwt.ParseWithClaims(raw, claims, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodECDSA); !ok {
			return nil, fmt.Errorf("auth: unexpected signing method %v", tok.Header["alg"])
		}
		return ecPub, nil
	}, jwt.WithIssuer(Issuer), jwt.WithAudience(Audience), jwt.WithValidMethods([]string{"ES256"}))
	if err != nil {
		return nil, fmt.Errorf("auth: invalid access token: %w", err)
	}
	if !parsed.Valid {
		return nil, fmt.Errorf("auth: invalid access token")
	}
	return claims, nil
}
