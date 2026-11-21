package security

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"os"
	"strings"
	"testing"
)

var bg = context.Background()

func ecKey(t *testing.T, curve elliptic.Curve) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func sec1PEM(t *testing.T, k *ecdsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func pkcs8PEM(t *testing.T, k any) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestEnvKeyManagerAcceptsP256InEveryEncoding(t *testing.T) {
	k := ecKey(t, elliptic.P256())
	for name, v := range map[string]string{
		"SEC1 PEM":             sec1PEM(t, k),
		"PKCS#8 PEM":           pkcs8PEM(t, k),
		"base64 of PEM":        base64.StdEncoding.EncodeToString([]byte(sec1PEM(t, k))),
		"PEM with \\n escapes": strings.ReplaceAll(pkcs8PEM(t, k), "\n", `\n`),
		"surrounding space":    "  \n" + sec1PEM(t, k) + "\n  ",
	} {
		t.Run(name, func(t *testing.T) {
			km, err := NewEnvKeyManager(EnvKeys{SigningKey: v})
			if err != nil {
				t.Fatal(err)
			}
			got, err := km.SigningKey(bg, AccessTokenSigningKeyID)
			if err != nil || !got.Equal(k) {
				t.Fatalf("signing key: %v (equal=%v)", err, err == nil && got.Equal(k))
			}
			pub, err := km.PublicKey(bg, AccessTokenSigningKeyID)
			if err != nil || !k.PublicKey.Equal(pub) {
				t.Fatalf("public key: %v", err)
			}
			digest := sha256.Sum256([]byte("qd"))
			sig, err := km.Sign(bg, AccessTokenSigningKeyID, digest[:])
			if err != nil || !ecdsa.VerifyASN1(&k.PublicKey, digest[:], sig) {
				t.Fatalf("sign: %v", err)
			}
		})
	}
}

func TestEnvKeyManagerRejectsUnusableKeys(t *testing.T) {
	p384 := ecKey(t, elliptic.P384())
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p256 := ecKey(t, elliptic.P256())
	pubDER, _ := x509.MarshalPKIXPublicKey(&p256.PublicKey)
	for name, v := range map[string]string{
		"empty":           "",
		"whitespace":      "   \n",
		"garbage":         "not a key",
		"bad base64":      "@@@@",
		"P-384":           sec1PEM(t, p384),
		"RSA":             pkcs8PEM(t, rsaKey),
		"public key only": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})),
		"corrupt PEM":     "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewEnvKeyManager(EnvKeys{SigningKey: v}); err == nil {
				t.Fatal("accepted an unusable signing key")
			}
		})
	}
}

// Error text reaches logs: it must never carry key material.
func TestEnvKeyManagerErrorsNeverContainKeyMaterial(t *testing.T) {
	k := ecKey(t, elliptic.P384()) // valid PEM, wrong curve: parsed, then refused
	v := sec1PEM(t, k)
	_, err := NewEnvKeyManager(EnvKeys{SigningKey: v})
	if err == nil {
		t.Fatal("want an error")
	}
	body := strings.Join(strings.Split(strings.TrimSpace(v), "\n")[1:3], "")
	for _, frag := range []string{body[:16], body[len(body)-16:]} {
		if strings.Contains(err.Error(), frag) {
			t.Fatalf("error leaks key material: %v", err)
		}
	}
	enc := base64.StdEncoding.EncodeToString([]byte("not a pem but secret-ish"))
	_, err = NewEnvKeyManager(EnvKeys{SigningKey: enc})
	if err == nil || strings.Contains(err.Error(), enc) || strings.Contains(err.Error(), "secret-ish") {
		t.Fatalf("error leaks the value: %v", err)
	}
}

// Keys come only from configuration: an unknown key id is an error, and
// nothing is generated or written to disk.
func TestEnvKeyManagerNeverGeneratesKeys(t *testing.T) {
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(wd) }()

	km, err := NewEnvKeyManager(EnvKeys{SigningKey: sec1PEM(t, ecKey(t, elliptic.P256()))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := km.SigningKey(bg, "some-other-key"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key id: %v", err)
	}
	if _, err := km.PublicKey(bg, "some-other-key"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key id: %v", err)
	}
	if _, err := km.Sign(bg, "some-other-key", make([]byte, 32)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key id: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("the env key manager wrote %d file(s)", len(entries))
	}
}

func TestEnvKeyManagerEncryption(t *testing.T) {
	signing := sec1PEM(t, ecKey(t, elliptic.P256()))
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	km, err := NewEnvKeyManager(EnvKeys{SigningKey: signing, EncryptionKey: base64.StdEncoding.EncodeToString(raw)})
	if err != nil {
		t.Fatal(err)
	}
	ct, err := km.Encrypt(bg, "field", []byte("hello"), []byte("aad"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := km.Decrypt(bg, "field", ct, []byte("aad"))
	if err != nil || string(pt) != "hello" {
		t.Fatalf("round trip: %q %v", pt, err)
	}
	if _, err := km.Decrypt(bg, "field", ct, []byte("other aad")); err == nil {
		t.Fatal("decrypted with the wrong associated data")
	}
	// Ciphertext is bound to its key id too.
	if _, err := km.Decrypt(bg, "other-field", ct, []byte("aad")); err == nil {
		t.Fatal("decrypted under another key id")
	}
	ct2, _ := km.Encrypt(bg, "field", []byte("hello"), []byte("aad"))
	if string(ct) == string(ct2) {
		t.Fatal("nonces repeat")
	}

	// Without an encryption key: a clear error, never a made-up key.
	noEnc, err := NewEnvKeyManager(EnvKeys{SigningKey: signing})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := noEnc.Encrypt(bg, "field", []byte("x"), nil); !errors.Is(err, ErrEncryptionNotConfigured) {
		t.Fatalf("encrypt without a key: %v", err)
	}
	// A configured encryption key must be exactly 32 bytes.
	for _, bad := range []string{"short", base64.StdEncoding.EncodeToString(make([]byte, 16)), "@@@"} {
		if _, err := NewEnvKeyManager(EnvKeys{SigningKey: signing, EncryptionKey: bad}); err == nil {
			t.Fatalf("accepted encryption key %q", bad)
		}
	}
}

func TestEnvKeyManagerFingerprintIsPublicAndStable(t *testing.T) {
	k := ecKey(t, elliptic.P256())
	a, _ := NewEnvKeyManager(EnvKeys{SigningKey: sec1PEM(t, k)})
	b, _ := NewEnvKeyManager(EnvKeys{SigningKey: pkcs8PEM(t, k)})
	c, _ := NewEnvKeyManager(EnvKeys{SigningKey: sec1PEM(t, ecKey(t, elliptic.P256()))})
	if a.Fingerprint() != b.Fingerprint() || a.Fingerprint() == c.Fingerprint() || len(a.Fingerprint()) != 16 {
		t.Fatalf("fingerprints: %s %s %s", a.Fingerprint(), b.Fingerprint(), c.Fingerprint())
	}
	pubDER, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	sum := sha256.Sum256(pubDER)
	if a.Fingerprint() != hexPrefix(sum[:], 8) {
		t.Fatalf("fingerprint is not SHA-256 of the public key: %s", a.Fingerprint())
	}
}

func hexPrefix(b []byte, n int) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, 2*n)
	for _, c := range b[:n] {
		out = append(out, digits[c>>4], digits[c&15])
	}
	return string(out)
}
