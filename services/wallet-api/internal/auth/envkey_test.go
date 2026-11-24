package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/security"
)

func envKM(t *testing.T) *security.EnvKeyManager {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalECPrivateKey(k)
	km, err := security.NewEnvKeyManager(security.EnvKeys{SigningKey: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))})
	if err != nil {
		t.Fatal(err)
	}
	return km
}

// Access tokens signed with the deployment's configured key verify on every
// instance that has the same key, and on no instance with another key.
func TestAccessTokensWithEnvKeyManager(t *testing.T) {
	ctx := context.Background()
	km := envKM(t)
	issuer := NewTokenIssuer(km)
	user, device, session := uuid.New(), uuid.New(), uuid.New()
	tok, exp, err := issuer.IssueAccessToken(ctx, user, device, session)
	if err != nil || exp.IsZero() {
		t.Fatalf("issue: %v", err)
	}
	// A second instance configured with the same key.
	claims, err := NewTokenIssuer(km).VerifyAccessToken(ctx, tok)
	if err != nil || claims.Subject != user.String() || claims.DeviceID != device.String() || claims.SessionID != session.String() {
		t.Fatalf("verify: %v %+v", err, claims)
	}
	// An instance with a different key rejects it.
	if _, err := NewTokenIssuer(envKM(t)).VerifyAccessToken(ctx, tok); err == nil {
		t.Fatal("a token signed with another key verified")
	}
}
