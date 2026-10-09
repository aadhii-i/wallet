package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func sha256sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func TestP1363RoundTrip(t *testing.T) {
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("QDWallet-Auth|v1|http://localhost:3000|chal-1|nonce-1|2026-01-01T00:00:00Z")
	digest := sha256sum(msg)
	r, s, err := ecdsa.Sign(rand.Reader, pk, digest)
	if err != nil {
		t.Fatal(err)
	}
	sig := EncodeP1363Signature(elliptic.P256(), r, s)
	sigB64 := base64.RawURLEncoding.EncodeToString(sig)

	if err := VerifyP1363SignatureB64URL(&pk.PublicKey, msg, sigB64); err != nil {
		t.Fatalf("expected valid signature to verify, got: %v", err)
	}

	// tamper with the message
	if err := VerifyP1363SignatureB64URL(&pk.PublicKey, []byte("tampered"), sigB64); err == nil {
		t.Fatal("expected tampered message to fail verification")
	}

	// tamper with the signature
	bad := make([]byte, len(sig))
	copy(bad, sig)
	bad[0] ^= 0xFF
	badB64 := base64.RawURLEncoding.EncodeToString(bad)
	if err := VerifyP1363SignatureB64URL(&pk.PublicKey, msg, badB64); err == nil {
		t.Fatal("expected tampered signature to fail verification")
	}
}

func TestParseSPKIPublicKeyRejectsNonP256(t *testing.T) {
	// A clearly invalid base64 blob should error, not panic.
	if _, err := ParseSPKIPublicKeyB64URL("!!!not-base64!!!"); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestSPKIRoundTrip(t *testing.T) {
	pk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := SPKIDER(&pk.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.RawURLEncoding.EncodeToString(der)
	pub, err := ParseSPKIPublicKeyB64URL(b64)
	if err != nil {
		t.Fatal(err)
	}
	if pub.X.Cmp(pk.PublicKey.X) != 0 || pub.Y.Cmp(pk.PublicKey.Y) != 0 {
		t.Fatal("round-tripped public key does not match")
	}
}
