package account

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"

	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// btcProofForMessage produces the exact proof format that wallet-core's
// btcOwnershipProof outputs: "0x" + hex(compressedPubKey(33) || r(32) || s(32)).
func btcProofForMessage(privKey *secp256k1.PrivateKey, message string) string {
	hash := sha256.Sum256([]byte(message))
	sig := ecdsa.Sign(privKey, hash[:])
	// Extract r and s from the DER serialisation.
	// DER: 0x30 <total len> 0x02 <rLen> <r bytes> 0x02 <sLen> <s bytes>
	der := sig.Serialize()
	r32, s32 := derToRS(der)
	pubKey := privKey.PubKey().SerializeCompressed()
	raw := make([]byte, 97)
	copy(raw[0:33], pubKey)
	copy(raw[33:65], r32[:])
	copy(raw[65:97], s32[:])
	return "0x" + hex.EncodeToString(raw)
}

// derToRS extracts the 32-byte big-endian r and s from a DER-encoded ECDSA sig.
func derToRS(der []byte) ([32]byte, [32]byte) {
	var r32, s32 [32]byte
	// Skip 0x30, total length.
	i := 2
	// r component: 0x02 <len> <bytes>
	rLen := int(der[i+1])
	rBytes := der[i+2 : i+2+rLen]
	if len(rBytes) > 32 {
		rBytes = rBytes[len(rBytes)-32:]
	}
	copy(r32[32-len(rBytes):], rBytes)
	i += 2 + rLen
	// s component: 0x02 <len> <bytes>
	sLen := int(der[i+1])
	sBytes := der[i+2 : i+2+sLen]
	if len(sBytes) > 32 {
		sBytes = sBytes[len(sBytes)-32:]
	}
	copy(s32[32-len(sBytes):], sBytes)
	return r32, s32
}

// btcAddressForKey derives the Bitcoin address for a private key, mirroring
// the client derivation so we can build self-consistent test vectors.
func btcAddressForKey(privKey *secp256k1.PrivateKey, addressType, network string) (string, error) {
	return btcAddressFromPubKey(privKey.PubKey().SerializeCompressed(), addressType, network)
}

func TestBtcAddressRegistrationMessageFormat(t *testing.T) {
	msg := BtcAddressRegistrationMessage("acc-1", "mainnet", "bc1qtest", "user-1")
	want := "QDWallet-BTC|v1|acc-1|mainnet|bc1qtest|user-1"
	if msg != want {
		t.Fatalf("unexpected message: got %q, want %q", msg, want)
	}
}

func TestVerifyBtcAddressProofValidP2WPKH(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000001"
	userID := "aabbccdd-0000-4000-8000-000000000002"
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	if err := VerifyBtcAddressProof(accountID, "mainnet", address, userID, "p2wpkh", proof); err != nil {
		t.Fatalf("expected valid P2WPKH proof to verify, got: %v", err)
	}
}

func TestVerifyBtcAddressProofValidP2TR(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2tr", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000003"
	userID := "aabbccdd-0000-4000-8000-000000000004"
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	if err := VerifyBtcAddressProof(accountID, "mainnet", address, userID, "p2tr", proof); err != nil {
		t.Fatalf("expected valid P2TR proof to verify, got: %v", err)
	}
}
func TestVerifyBtcAddressProofValidTestnet4(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2wpkh", "testnet4")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000005"
	userID := "aabbccdd-0000-4000-8000-000000000006"
	message := BtcAddressRegistrationMessage(accountID, "testnet4", address, userID)
	proof := btcProofForMessage(privKey, message)

	if err := VerifyBtcAddressProof(accountID, "testnet4", address, userID, "p2wpkh", proof); err != nil {
		t.Fatalf("expected valid testnet4 proof to verify, got: %v", err)
	}
}

func TestVerifyBtcAddressProofRejectsWrongAddress(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	// Generate a different key to get a different address.
	otherKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	otherAddress, err := btcAddressForKey(otherKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000007"
	userID := "aabbccdd-0000-4000-8000-000000000008"
	// Sign for `address` but submit as proof for `otherAddress`.
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	err = VerifyBtcAddressProof(accountID, "mainnet", otherAddress, userID, "p2wpkh", proof)
	if err == nil {
		t.Fatal("expected proof for a different address to be rejected")
	}
}

func TestVerifyBtcAddressProofRejectsTamperedAccountID(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000009"
	otherAccountID := "aabbccdd-0000-4000-8000-00000000000a"
	userID := "aabbccdd-0000-4000-8000-00000000000b"
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	err = VerifyBtcAddressProof(otherAccountID, "mainnet", address, userID, "p2wpkh", proof)
	if err == nil {
		t.Fatal("expected proof bound to a different accountId to be rejected")
	}
}

func TestVerifyBtcAddressProofRejectsTamperedUserID(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address, err := btcAddressForKey(privKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-00000000000c"
	userID := "aabbccdd-0000-4000-8000-00000000000d"
	otherUserID := "aabbccdd-0000-4000-8000-00000000000e"
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	err = VerifyBtcAddressProof(accountID, "mainnet", address, otherUserID, "p2wpkh", proof)
	if err == nil {
		t.Fatal("expected proof bound to a different userId to be rejected")
	}
}

func TestVerifyBtcAddressProofRejectsMalformedProof(t *testing.T) {
	cases := []struct {
		name  string
		proof string
	}{
		{"empty", ""},
		{"no 0x prefix", "aabbcc"},
		{"too short", "0x" + "aa"},
		{"too long", "0x" + fmt.Sprintf("%200s", "")},
		{"not hex", "0x" + "gg" + hex.EncodeToString(make([]byte, 95))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyBtcAddressProof("acc", "mainnet", "bc1qtest", "user", "p2wpkh", tc.proof)
			if err == nil {
				t.Fatalf("expected malformed proof %q to be rejected", tc.proof)
			}
		})
	}
}

func TestVerifyBtcAddressProofRejectsUnsupportedNetwork(t *testing.T) {
	privKey, _ := secp256k1.GeneratePrivateKey()
	proof := btcProofForMessage(privKey, "msg")
	err := VerifyBtcAddressProof("acc", "regtest", "addr", "user", "p2wpkh", proof)
	if err == nil {
		t.Fatal("expected unsupported network to be rejected")
	}
}

func TestVerifyBtcAddressProofRejectsUnsupportedAddressType(t *testing.T) {
	privKey, _ := secp256k1.GeneratePrivateKey()
	proof := btcProofForMessage(privKey, "msg")
	err := VerifyBtcAddressProof("acc", "mainnet", "addr", "user", "p2sh", proof)
	if err == nil {
		t.Fatal("expected unsupported address type to be rejected")
	}
}

func TestVerifyBtcAddressProofRejectsNetworkMismatch(t *testing.T) {
	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	// Derive a mainnet address.
	mainnetAddress, err := btcAddressForKey(privKey, "p2wpkh", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-00000000000f"
	userID := "aabbccdd-0000-4000-8000-000000000010"
	// Sign for mainnet.
	message := BtcAddressRegistrationMessage(accountID, "mainnet", mainnetAddress, userID)
	proof := btcProofForMessage(privKey, message)

	// Submit as a testnet4 registration — the message content differs, so
	// the signature won't verify anyway; but even if it did, the address
	// starts with "bc1" which won't match a testnet4 derivation.
	err = VerifyBtcAddressProof(accountID, "testnet4", mainnetAddress, userID, "p2wpkh", proof)
	if err == nil {
		t.Fatal("expected mainnet proof to be rejected for testnet4")
	}
}

// TestTaprootOutputKeyParityIndependence is the core regression test for the
// lift_x fix.  BIP-341 defines the output key as Q = lift_x(x(P)) + t·G,
// where lift_x always returns the even-Y point.  This means a compressed
// internal key with prefix 0x03 and its negation (prefix 0x02, same x) must
// produce the SAME output key — because both share the same x coordinate and
// lift_x discards the parity bit.
//
// Before the fix, the backend used ParsePubKey (which preserves parity) and
// got a different output key for 0x03 keys, causing VerifyBtcAddressProof to
// fail for ~50% of P2TR accounts.
func TestTaprootOutputKeyParityIndependence(t *testing.T) {
	// Generate keys until we have at least one with odd Y (0x03) and one
	// with even Y (0x02).  On average this takes 2–4 iterations.
	var oddPub, evenPub []byte
	for i := 0; i < 200 && (oddPub == nil || evenPub == nil); i++ {
		pk, err := secp256k1.GeneratePrivateKey()
		if err != nil {
			t.Fatal(err)
		}
		pub := pk.PubKey().SerializeCompressed()
		if pub[0] == 0x03 && oddPub == nil {
			oddPub = pub
		} else if pub[0] == 0x02 && evenPub == nil {
			evenPub = pub
		}
	}
	if oddPub == nil {
		t.Skip("could not generate an odd-Y key in 200 iterations")
	}
	if evenPub == nil {
		t.Skip("could not generate an even-Y key in 200 iterations")
	}

	// For an odd-Y key: build its negation (same x, flipped prefix) and verify
	// that both produce the same taprootOutputKey.
	negated := make([]byte, 33)
	copy(negated, oddPub)
	negated[0] = 0x02 // flip to even Y (the negated point)

	outputFromOdd, err := taprootOutputKey(oddPub)
	if err != nil {
		t.Fatalf("taprootOutputKey(odd-Y): %v", err)
	}
	outputFromNegated, err := taprootOutputKey(negated)
	if err != nil {
		t.Fatalf("taprootOutputKey(negated): %v", err)
	}

	if hex.EncodeToString(outputFromOdd) != hex.EncodeToString(outputFromNegated) {
		t.Errorf("lift_x parity independence violated:\n"+
			"  odd-Y input    %s\n"+
			"  negated input  %s\n"+
			"  output (odd)   %s\n"+
			"  output (even)  %s",
			hex.EncodeToString(oddPub),
			hex.EncodeToString(negated),
			hex.EncodeToString(outputFromOdd),
			hex.EncodeToString(outputFromNegated),
		)
	}
}

// TestVerifyBtcAddressProofP2TROddYKey verifies the full proof-verification
// pipeline specifically for a P2TR account whose internal key has odd Y.
// This is the exact case the original implementation failed on.
func TestVerifyBtcAddressProofP2TROddYKey(t *testing.T) {
	// Generate keys until we find one with an odd-Y public key (prefix 0x03).
	var privKey *secp256k1.PrivateKey
	for i := 0; i < 200; i++ {
		pk, err := secp256k1.GeneratePrivateKey()
		if err != nil {
			t.Fatal(err)
		}
		if pk.PubKey().SerializeCompressed()[0] == 0x03 {
			privKey = pk
			break
		}
	}
	if privKey == nil {
		t.Skip("could not generate an odd-Y key in 200 iterations")
	}

	pub := privKey.PubKey().SerializeCompressed()
	if pub[0] != 0x03 {
		t.Fatalf("expected odd-Y key (0x03 prefix), got 0x%02x", pub[0])
	}

	address, err := btcAddressForKey(privKey, "p2tr", "mainnet")
	if err != nil {
		t.Fatal(err)
	}
	accountID := "aabbccdd-0000-4000-8000-000000000011"
	userID := "aabbccdd-0000-4000-8000-000000000012"
	message := BtcAddressRegistrationMessage(accountID, "mainnet", address, userID)
	proof := btcProofForMessage(privKey, message)

	if err := VerifyBtcAddressProof(accountID, "mainnet", address, userID, "p2tr", proof); err != nil {
		t.Fatalf("P2TR proof with odd-Y internal key failed: %v\n"+
			"pubkey prefix: 0x%02x — this was the failing case before the lift_x fix",
			err, pub[0])
	}
}
