package security

import (
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"strings"
)

// AccessTokenSigningKeyID names the ES256 key that signs access tokens.
const AccessTokenSigningKeyID = "access-token-signing-key"

// ErrUnknownKey: the key id is not configured. The env key manager never
// creates keys on demand.
var ErrUnknownKey = errors.New("security: unknown key id")

// ErrEncryptionNotConfigured: Encrypt/Decrypt were called without
// KEY_ENCRYPTION_KEY.
var ErrEncryptionNotConfigured = errors.New("security: KEY_ENCRYPTION_KEY is not configured")

// EnvKeys are the key-manager secrets, as given in the environment.
type EnvKeys struct {
	// SigningKey (JWT_SIGNING_KEY): a P-256 private key as PEM (SEC1
	// "EC PRIVATE KEY" or PKCS#8 "PRIVATE KEY"), the PEM base64-encoded, or
	// the PEM with literal \n escapes.
	SigningKey string
	// EncryptionKey (KEY_ENCRYPTION_KEY, optional): 32 random bytes,
	// base64-encoded (standard or URL alphabet, padding optional).
	EncryptionKey string
}

// EnvKeyManager holds keys supplied by the deployment (for example Render
// secret environment variables). Unlike LocalDevKeyManager it never
// generates or writes a key: every instance of the API loads the same keys,
// so tokens one instance signs verify on all of them, and a restart keeps
// sessions valid. Nothing here logs or returns key material.
type EnvKeyManager struct {
	signing     *ecdsa.PrivateKey
	encryption  []byte // nil when not configured
	fingerprint string
}

// NewEnvKeyManager parses and checks the configured keys.
func NewEnvKeyManager(keys EnvKeys) (*EnvKeyManager, error) {
	signing, err := parseSigningKey(keys.SigningKey)
	if err != nil {
		return nil, fmt.Errorf("security: JWT_SIGNING_KEY: %w", err)
	}
	km := &EnvKeyManager{signing: signing}
	if strings.TrimSpace(keys.EncryptionKey) != "" {
		raw, err := decodeBase64(strings.TrimSpace(keys.EncryptionKey))
		if err != nil {
			return nil, errors.New("security: KEY_ENCRYPTION_KEY is not valid base64")
		}
		if len(raw) != 32 {
			return nil, fmt.Errorf("security: KEY_ENCRYPTION_KEY must decode to 32 bytes, got %d", len(raw))
		}
		km.encryption = raw
	}
	der, err := x509.MarshalPKIXPublicKey(&signing.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("security: JWT_SIGNING_KEY: %w", err)
	}
	sum := sha256.Sum256(der)
	km.fingerprint = hex.EncodeToString(sum[:8])
	return km, nil
}

// Fingerprint identifies the signing key without revealing it: the first 8
// bytes of SHA-256 over its public key (SubjectPublicKeyInfo), in hex. Safe
// to log, so operators can confirm which key an instance runs with.
func (k *EnvKeyManager) Fingerprint() string { return k.fingerprint }

// HasEncryptionKey reports whether KEY_ENCRYPTION_KEY was configured.
func (k *EnvKeyManager) HasEncryptionKey() bool { return k.encryption != nil }

func (k *EnvKeyManager) key(keyID string) (*ecdsa.PrivateKey, error) {
	if keyID != AccessTokenSigningKeyID {
		return nil, fmt.Errorf("%w: %q", ErrUnknownKey, keyID)
	}
	return k.signing, nil
}

func (k *EnvKeyManager) SigningKey(_ context.Context, keyID string) (*ecdsa.PrivateKey, error) {
	return k.key(keyID)
}

func (k *EnvKeyManager) PublicKey(_ context.Context, keyID string) (crypto.PublicKey, error) {
	pk, err := k.key(keyID)
	if err != nil {
		return nil, err
	}
	return &pk.PublicKey, nil
}

func (k *EnvKeyManager) Sign(_ context.Context, keyID string, digest []byte) ([]byte, error) {
	pk, err := k.key(keyID)
	if err != nil {
		return nil, err
	}
	return ecdsa.SignASN1(rand.Reader, pk, digest)
}

// Encrypt seals plaintext with AES-256-GCM under a subkey derived from
// KEY_ENCRYPTION_KEY for keyID (HKDF-SHA256), so a ciphertext only opens
// under the key id it was sealed for. Output: nonce || ciphertext || tag.
func (k *EnvKeyManager) Encrypt(_ context.Context, keyID string, plaintext, aad []byte) ([]byte, error) {
	gcm, err := k.aead(keyID)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

func (k *EnvKeyManager) Decrypt(_ context.Context, keyID string, ciphertext, aad []byte) ([]byte, error) {
	gcm, err := k.aead(keyID)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("security: ciphertext too short")
	}
	nonce, body := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, body, aad)
	if err != nil {
		return nil, errors.New("security: decryption failed")
	}
	return pt, nil
}

func (k *EnvKeyManager) aead(keyID string) (cipher.AEAD, error) {
	if k.encryption == nil {
		return nil, ErrEncryptionNotConfigured
	}
	if keyID == "" {
		return nil, fmt.Errorf("%w: empty key id", ErrUnknownKey)
	}
	sub, err := hkdf.Key(sha256.New, k.encryption, nil, "qd-wallet/key-manager/v1/"+keyID, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(sub)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// parseSigningKey accepts PEM, base64-encoded PEM, or PEM whose newlines
// were entered as literal "\n". Errors describe the problem only, never the
// value.
func parseSigningKey(v string) (*ecdsa.PrivateKey, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, errors.New("not set")
	}
	data := []byte(strings.ReplaceAll(v, `\n`, "\n"))
	if !strings.Contains(string(data), "-----BEGIN") {
		raw, err := decodeBase64(v)
		if err != nil || !strings.Contains(string(raw), "-----BEGIN") {
			return nil, errors.New("expected a PEM private key (or the PEM base64-encoded)")
		}
		data = raw
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	var key any
	var err error
	switch block.Type {
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	default:
		return nil, fmt.Errorf("PEM block is %q; want \"EC PRIVATE KEY\" or \"PRIVATE KEY\"", block.Type)
	}
	if err != nil {
		return nil, errors.New("could not parse the private key")
	}
	ec, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("key is %T; want an ECDSA P-256 key", key)
	}
	if ec.Curve != elliptic.P256() {
		return nil, fmt.Errorf("key is on %s; want P-256 (ES256)", ec.Curve.Params().Name)
	}
	return ec, nil
}

func decodeBase64(s string) ([]byte, error) {
	s = strings.Join(strings.Fields(s), "")
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("invalid base64")
}
