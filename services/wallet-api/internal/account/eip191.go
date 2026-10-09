// Package account implements wallets, accounts, and registered public
// addresses (spec §9.2 `account`), including EIP-191 personal_sign proof
// verification for address registration.
package account

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var ErrInvalidProof = errors.New("account: invalid address ownership proof")

// AddressRegistrationMessage builds the exact message the client must
// personal_sign to prove control of an EVM address:
// `QDWallet-Address|v1|{accountId}|{address-lowercase}|{userId}`.
func AddressRegistrationMessage(accountID, address, userID string) string {
	return fmt.Sprintf("QDWallet-Address|v1|%s|%s|%s", accountID, strings.ToLower(address), userID)
}

// personalSignHash reproduces go-ethereum's / MetaMask's eth_sign / personal_sign
// prefix hash: keccak256("\x19Ethereum Signed Message:\n" + len(message) + message).
func personalSignHash(message []byte) []byte {
	prefix := fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(message))
	return crypto.Keccak256([]byte(prefix + string(message)))
}

// VerifyAddressProof checks that proofHex (0x + 130 hex chars = 65 bytes,
// r||s||v) is a valid personal_sign signature over
// AddressRegistrationMessage(accountID, address, userID), recovered to
// `address`.
func VerifyAddressProof(accountID, address, userID, proofHex string) error {
	if !strings.HasPrefix(proofHex, "0x") || len(proofHex) != 132 {
		return fmt.Errorf("%w: proof must be 0x + 130 hex chars", ErrInvalidProof)
	}
	sig, err := hex.DecodeString(proofHex[2:])
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidProof, err)
	}
	if len(sig) != 65 {
		return fmt.Errorf("%w: signature must be 65 bytes", ErrInvalidProof)
	}
	// go-ethereum's Ecrecover wants the recovery id in [0,1]; personal_sign
	// wallets produce v in {27,28} (or {0,1} from some libraries).
	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v != 0 && v != 1 {
		return fmt.Errorf("%w: invalid recovery id", ErrInvalidProof)
	}
	normalized := make([]byte, 65)
	copy(normalized, sig[:64])
	normalized[64] = v

	message := AddressRegistrationMessage(accountID, address, userID)
	hash := personalSignHash([]byte(message))

	pubKey, err := crypto.SigToPub(hash, normalized)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidProof, err)
	}
	recovered := crypto.PubkeyToAddress(*pubKey)
	want := common.HexToAddress(address)
	if recovered != want {
		return fmt.Errorf("%w: recovered %s, want %s", ErrInvalidProof, recovered.Hex(), want.Hex())
	}
	return nil
}

// NormalizeAddress lowercases and validates the shape of an EVM address
// (0x + 40 hex chars). It does not perform EIP-55 checksum validation; the
// client is responsible for display checksums.
func NormalizeAddress(address string) (string, error) {
	if !common.IsHexAddress(address) {
		return "", fmt.Errorf("account: invalid EVM address %q", address)
	}
	return strings.ToLower(address), nil
}
