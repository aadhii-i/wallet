package account

import (
	"encoding/hex"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
)

func TestVerifyAddressProofValid(t *testing.T) {
	pk, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	accountID := uuid.NewString()
	userID := uuid.NewString()

	message := AddressRegistrationMessage(accountID, address, userID)
	hash := personalSignHash([]byte(message))
	sig, err := crypto.Sign(hash, pk)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27 // convert to the wire {27,28} convention
	proofHex := "0x" + hex.EncodeToString(sig)

	if err := VerifyAddressProof(accountID, address, userID, proofHex); err != nil {
		t.Fatalf("expected valid proof to verify, got: %v", err)
	}
}

func TestVerifyAddressProofRejectsWrongAddress(t *testing.T) {
	pk, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	accountID := uuid.NewString()
	userID := uuid.NewString()

	message := AddressRegistrationMessage(accountID, address, userID)
	hash := personalSignHash([]byte(message))
	sig, err := crypto.Sign(hash, pk)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	proofHex := "0x" + hex.EncodeToString(sig)

	otherPk, _ := crypto.GenerateKey()
	otherAddress := crypto.PubkeyToAddress(otherPk.PublicKey).Hex()

	if err := VerifyAddressProof(accountID, otherAddress, userID, proofHex); err == nil {
		t.Fatal("expected proof for a different address to be rejected")
	}
}

func TestVerifyAddressProofRejectsMalformedProof(t *testing.T) {
	if err := VerifyAddressProof("acc", "0x0000000000000000000000000000000000000000", "user", "not-a-proof"); err == nil {
		t.Fatal("expected malformed proof to be rejected")
	}
}

func TestVerifyAddressProofRejectsTamperedMessage(t *testing.T) {
	pk, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := crypto.PubkeyToAddress(pk.PublicKey).Hex()
	message := AddressRegistrationMessage("acc-1", address, "user-1")
	hash := personalSignHash([]byte(message))
	sig, err := crypto.Sign(hash, pk)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	proofHex := "0x" + hex.EncodeToString(sig)

	// Using a different accountId changes the signed message, so
	// verification against "acc-2" must fail.
	if err := VerifyAddressProof("acc-2", address, "user-1", proofHex); err == nil {
		t.Fatal("expected proof bound to a different accountId to be rejected")
	}
}
