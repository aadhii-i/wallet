// Package security holds cross-cutting security primitives that do not
// belong to a single domain package: the KeyManager abstraction (§13.3 of
// the spec), security-event recording, rate limiting, CSRF token
// generation/verification, and IP hashing.
package security

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// KeyManager is the abstraction over asymmetric signing keys and envelope
// encryption used for session tokens, CSRF secrets, and (in a future
// milestone) MPC share encryption. The only implementation shipped here is
// "localdev", which is refused when APP_ENV=production.
type KeyManager interface {
	Sign(ctx context.Context, keyID string, digest []byte) ([]byte, error)
	PublicKey(ctx context.Context, keyID string) (crypto.PublicKey, error)
	// SigningKey returns the raw ecdsa key for keyID, for use with libraries
	// (e.g. golang-jwt) that want a crypto.Signer / *ecdsa.PrivateKey
	// directly rather than a Sign() call.
	SigningKey(ctx context.Context, keyID string) (*ecdsa.PrivateKey, error)

	Encrypt(ctx context.Context, keyID string, plaintext, aad []byte) ([]byte, error)
	Decrypt(ctx context.Context, keyID string, ciphertext, aad []byte) ([]byte, error)
}

// LocalDevKeyManager stores ES256 (P-256) signing keys as PEM files under a
// directory, generating them on first use. It is only for local development
// and tests; NewLocalDevKeyManager refuses to construct one when
// isProduction is true.
type LocalDevKeyManager struct {
	dir  string
	mu   sync.Mutex
	keys map[string]*ecdsa.PrivateKey
}

func NewLocalDevKeyManager(dir string, isProduction bool) (*LocalDevKeyManager, error) {
	if isProduction {
		return nil, errors.New("security: localdev KeyManager is refused when APP_ENV=production")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("security: create dev key dir: %w", err)
	}
	return &LocalDevKeyManager{dir: dir, keys: map[string]*ecdsa.PrivateKey{}}, nil
}

func (k *LocalDevKeyManager) keyPath(keyID string) string {
	return filepath.Join(k.dir, keyID+".pem")
}

func (k *LocalDevKeyManager) loadOrCreate(keyID string) (*ecdsa.PrivateKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if pk, ok := k.keys[keyID]; ok {
		return pk, nil
	}
	path := k.keyPath(keyID)
	if data, err := os.ReadFile(path); err == nil {
		block, _ := pem.Decode(data)
		if block == nil {
			return nil, fmt.Errorf("security: invalid PEM in %s", path)
		}
		pk, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("security: parse key %s: %w", path, err)
		}
		k.keys[keyID] = pk
		return pk, nil
	}
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(pk)
	if err != nil {
		return nil, err
	}
	block := &pem.Block{Type: "EC PRIVATE KEY", Bytes: der}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		return nil, fmt.Errorf("security: write key %s: %w", path, err)
	}
	k.keys[keyID] = pk
	return pk, nil
}

func (k *LocalDevKeyManager) SigningKey(_ context.Context, keyID string) (*ecdsa.PrivateKey, error) {
	return k.loadOrCreate(keyID)
}

func (k *LocalDevKeyManager) Sign(ctx context.Context, keyID string, digest []byte) ([]byte, error) {
	pk, err := k.loadOrCreate(keyID)
	if err != nil {
		return nil, err
	}
	return ecdsa.SignASN1(rand.Reader, pk, digest)
}

func (k *LocalDevKeyManager) PublicKey(ctx context.Context, keyID string) (crypto.PublicKey, error) {
	pk, err := k.loadOrCreate(keyID)
	if err != nil {
		return nil, err
	}
	return &pk.PublicKey, nil
}

// Encrypt/Decrypt are provided for interface completeness (e.g. a future
// envelope-encrypted column). localdev uses AES-GCM with a key derived from
// a dedicated symmetric file, never from the signing key.
func (k *LocalDevKeyManager) Encrypt(ctx context.Context, keyID string, plaintext, aad []byte) ([]byte, error) {
	return aesGCMSeal(k.dir, keyID, plaintext, aad)
}

func (k *LocalDevKeyManager) Decrypt(ctx context.Context, keyID string, ciphertext, aad []byte) ([]byte, error) {
	return aesGCMOpen(k.dir, keyID, ciphertext, aad)
}
