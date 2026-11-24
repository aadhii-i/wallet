package qdaccount

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// Same pinned values as packages/qd-account/test/vectors.test.ts.
func TestCrossLanguageVectors(t *testing.T) {
	if got := VerifierAddress().Hex(); got != "0xD2f338D9aa4F28fD669e76515FC91F8b872830cE" {
		t.Fatalf("verifier %s", got)
	}
	if got := FactoryAddress().Hex(); got != "0xCC9B4F663F3656e974ac38065933e6752AFDB1Df" {
		t.Fatalf("factory %s", got)
	}
	var vk [32]byte
	copy(vk[:], bytes.Repeat([]byte{0x11}, 32))
	account := AccountAddress(vk)
	if account.Hex() != "0xEf2d12c08016FE0E3aF45d10DE2f1C88b61e2aa4" {
		t.Fatalf("account %s", account.Hex())
	}
	var digest [32]byte
	copy(digest[:], bytes.Repeat([]byte{0x33}, 32))
	c := &Call{
		Nonce: big.NewInt(3), To: common.BytesToAddress(bytes.Repeat([]byte{0x22}, 20)),
		Value: big.NewInt(10_000_000_000_000_000), Data: common.FromHex("0xdeadbeef"),
		CallGasLimit: big.NewInt(50_000), ValidUntil: big.NewInt(1_800_000_000), ProposalDigest: digest,
	}
	msg := ExecutionMessage(big.NewInt(31337), account, c)
	if common.Bytes2Hex(msg[:]) != "23efda831e901b586d38c2cf9318928fe87e878b723eaddf51f21808d3821c68" {
		t.Fatalf("message %x", msg)
	}
	data, err := ExecuteCalldata(c, make([]byte, 5152), make([]byte, 19494))
	if err != nil || len(data) < 4+19494 {
		t.Fatalf("execute calldata: %v", err)
	}
}
