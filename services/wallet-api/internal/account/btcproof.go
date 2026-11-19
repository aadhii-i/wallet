package account

// Bitcoin address ownership-proof verification.
//
// The client produces the proof with btcOwnershipProof (packages/wallet-core):
//
//	proof = "0x" + hex( compressed_pubkey(33 bytes) || ecdsa_sig_r(32 bytes) || ecdsa_sig_s(32 bytes) )
//
// The signing hash is sha256(message), where message is:
//
//	"QDWallet-BTC|v1|{accountId}|{network}|{address}|{userId}"
//
// Verification:
//  1. Decode the proof hex into pubkey (bytes 0-32) and compact sig (bytes 33-96).
//  2. Parse the compressed public key with secp256k1.
//  3. Build a Signature from the raw r||s bytes.
//  4. Call sig.Verify(sha256(message), pubkey).
//  5. Derive the Bitcoin address from the public key.
//  6. Compare the derived address against the address submitted in the request.
//     This prevents a proof for key K being accepted for an unrelated address.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// ErrInvalidBtcProof is returned when a Bitcoin ownership proof fails
// to verify.
var ErrInvalidBtcProof = errors.New("account: invalid bitcoin address ownership proof")

// BtcAddressRegistrationMessage builds the exact message the client's
// KeyWorker signs when proving control of a Bitcoin address.  The format
// must stay in sync with the BTC_PROOF_RE regex in key-worker.ts:
//
//	QDWallet-BTC|v1|{accountId}|{network}|{address}|{userId}
func BtcAddressRegistrationMessage(accountID, network, address, userID string) string {
	return fmt.Sprintf("QDWallet-BTC|v1|%s|%s|%s|%s", accountID, network, address, userID)
}

// VerifyBtcAddressProof checks that proofHex is a valid ownership proof for
// address on the given Bitcoin network.
//
// proofHex must be "0x" followed by 192 hex characters (96 bytes):
//
//	bytes  0-32: compressed secp256k1 public key
//	bytes 33-64: big-endian r component of the ECDSA signature
//	bytes 65-96: big-endian s component of the ECDSA signature
//
// address must be a lowercase bech32 / bech32m segwit address.
// network must be "mainnet" or "testnet4".
func VerifyBtcAddressProof(accountID, network, address, userID, addressType, proofHex string) error {
	// --- basic input validation -------------------------------------------
	if network != "mainnet" && network != "testnet4" {
		return fmt.Errorf("%w: unsupported network %q", ErrInvalidBtcProof, network)
	}
	if addressType != "p2wpkh" && addressType != "p2tr" {
		return fmt.Errorf("%w: unsupported address type %q", ErrInvalidBtcProof, addressType)
	}
	// 0x + 194 hex chars = 97 bytes: 33 (pubkey) + 32 (r) + 32 (s)
	if !strings.HasPrefix(proofHex, "0x") || len(proofHex) != 196 {
		return fmt.Errorf("%w: proof must be 0x followed by 194 hex characters", ErrInvalidBtcProof)
	}
	raw, err := hex.DecodeString(proofHex[2:])
	if err != nil {
		return fmt.Errorf("%w: proof is not valid hex: %v", ErrInvalidBtcProof, err)
	}
	if len(raw) != 97 {
		return fmt.Errorf("%w: proof must be 97 bytes", ErrInvalidBtcProof)
	}

	// --- parse public key --------------------------------------------------
	pubKeyBytes := raw[:33]
	pubKey, err := secp256k1.ParsePubKey(pubKeyBytes)
	if err != nil {
		return fmt.Errorf("%w: cannot parse public key: %v", ErrInvalidBtcProof, err)
	}

	// --- parse compact r||s signature (64 bytes, no recovery byte) ---------
	var r, s secp256k1.ModNScalar
	var r32, s32 [32]byte
	copy(r32[:], raw[33:65])
	copy(s32[:], raw[65:97])
	r.SetBytes(&r32)
	s.SetBytes(&s32)
	sig := ecdsa.NewSignature(&r, &s)

	// --- verify signature --------------------------------------------------
	message := BtcAddressRegistrationMessage(accountID, network, address, userID)
	hash := sha256.Sum256([]byte(message))
	if !sig.Verify(hash[:], pubKey) {
		return fmt.Errorf("%w: signature does not verify", ErrInvalidBtcProof)
	}

	// --- derive the Bitcoin address from the public key --------------------
	// This confirms the proof's public key actually controls the submitted address.
	derived, err := btcAddressFromPubKey(pubKeyBytes, addressType, network)
	if err != nil {
		return fmt.Errorf("%w: cannot derive address from public key: %v", ErrInvalidBtcProof, err)
	}
	if derived != strings.ToLower(address) {
		return fmt.Errorf("%w: proof public key derives to %s, want %s", ErrInvalidBtcProof, derived, strings.ToLower(address))
	}
	return nil
}
