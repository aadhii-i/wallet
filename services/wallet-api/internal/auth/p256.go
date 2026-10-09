// Package auth implements device-key challenge/response authentication,
// sessions, JWT access tokens, refresh rotation with reuse detection, and
// CSRF/middleware plumbing, per spec §22/§23 and docs/api/openapi.yaml.
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
)

// ErrInvalidSignature is returned when a P-256 signature fails verification.
var ErrInvalidSignature = errors.New("auth: invalid signature")

// ParseSPKIPublicKeyB64URL decodes a base64url (no padding) SPKI DER blob
// into a P-256 ECDSA public key.
func ParseSPKIPublicKeyB64URL(b64 string) (*ecdsa.PublicKey, error) {
	der, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		// tolerate padded base64url too, for lenient clients
		der, err = base64.URLEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("auth: invalid base64url public key: %w", err)
		}
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("auth: invalid SPKI public key: %w", err)
	}
	ecPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("auth: public key is not ECDSA")
	}
	if ecPub.Curve != elliptic.P256() {
		return nil, errors.New("auth: public key is not P-256")
	}
	return ecPub, nil
}

// SPKIDER returns the SPKI DER bytes for storage (canonical form used as
// the device's identity / dedup key).
func SPKIDER(pub *ecdsa.PublicKey) ([]byte, error) {
	return x509.MarshalPKIXPublicKey(pub)
}

// VerifyP1363SignatureB64URL verifies message against a base64url-encoded
// IEEE P1363 signature (r||s, 64 bytes for P-256) using pub.
func VerifyP1363SignatureB64URL(pub *ecdsa.PublicKey, message []byte, sigB64 string) error {
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		sig, err = base64.URLEncoding.DecodeString(sigB64)
		if err != nil {
			return fmt.Errorf("auth: invalid base64url signature: %w", err)
		}
	}
	return VerifyP1363Signature(pub, message, sig)
}

// VerifyP1363Signature verifies a raw IEEE P1363 (r||s) signature over
// SHA-256(message).
func VerifyP1363Signature(pub *ecdsa.PublicKey, message, sig []byte) error {
	byteLen := (pub.Curve.Params().BitSize + 7) / 8
	if len(sig) != 2*byteLen {
		return fmt.Errorf("%w: expected %d bytes, got %d", ErrInvalidSignature, 2*byteLen, len(sig))
	}
	r := new(big.Int).SetBytes(sig[:byteLen])
	s := new(big.Int).SetBytes(sig[byteLen:])
	digest := sha256.Sum256(message)
	if !ecdsa.Verify(pub, digest[:], r, s) {
		return ErrInvalidSignature
	}
	return nil
}

// EncodeP1363Signature converts (r,s) big.Ints into the fixed-width r||s
// encoding used by WebCrypto / clients, for tests that sign with
// crypto/ecdsa and need to produce the wire format.
func EncodeP1363Signature(curve elliptic.Curve, r, s *big.Int) []byte {
	byteLen := (curve.Params().BitSize + 7) / 8
	out := make([]byte, 2*byteLen)
	r.FillBytes(out[:byteLen])
	s.FillBytes(out[byteLen:])
	return out
}
