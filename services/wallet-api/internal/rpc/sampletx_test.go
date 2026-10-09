package rpc_test

import (
	"crypto/rand"
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// sampleRawTx returns a validly-RLP-encoded, signed legacy transaction hex
// string (0x-prefixed) for use as an eth_sendRawTransaction payload in
// tests. The signing key is a throwaway generated per-call; the chain ID
// used (1) is irrelevant since the fake upstreams never validate it.
func sampleRawTx(t *testing.T) string {
	t.Helper()
	pk, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	to := crypto.PubkeyToAddress(pk.PublicKey)
	tx := types.NewTransaction(0, to, big.NewInt(1), 21000, big.NewInt(1_000_000_000), nil)
	signer := types.NewEIP155Signer(big.NewInt(1))
	signedTx, err := types.SignTx(tx, signer, pk)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signedTx.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return "0x" + hex.EncodeToString(raw)
}

var _ = rand.Reader
