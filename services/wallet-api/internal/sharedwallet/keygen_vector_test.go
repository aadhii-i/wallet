package sharedwallet

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Shared with packages/rpc/test/shared-keygen.test.ts: the client signs these
// exact strings, so any drift between the two implementations breaks a test.
func keygenVectorFixture() (*store.KeyGeneration, []*store.KeygenParticipant) {
	kg := &store.KeyGeneration{
		ID:                uuid.MustParse("01900000-0000-7000-8000-0000000000a1"),
		WalletID:          uuid.MustParse("01900000-0000-7000-8000-000000000002"),
		MembershipVersion: 5, Threshold: 2, Parties: 3,
		Fingerprint: bytes.Repeat([]byte{0xab}, 32),
	}
	parts := []*store.KeygenParticipant{
		{MemberID: uuid.MustParse("01900000-0000-7000-8000-000000000006"), PartyIndex: 3, EnvelopeHash: bytes.Repeat([]byte{0x03}, 32)},
		{MemberID: uuid.MustParse("01900000-0000-7000-8000-000000000004"), PartyIndex: 1, EnvelopeHash: bytes.Repeat([]byte{0x01}, 32)},
		{MemberID: uuid.MustParse("01900000-0000-7000-8000-000000000005"), PartyIndex: 2, EnvelopeHash: bytes.Repeat([]byte{0x02}, 32)},
	}
	return kg, parts
}

func TestKeygenMessageVectors(t *testing.T) {
	kg, parts := keygenVectorFixture()
	key := bytes.Repeat([]byte{0x07}, xwingPublicKeyBytes)
	const (
		wallet, keygen = "01900000-0000-7000-8000-000000000002", "01900000-0000-7000-8000-0000000000a1"
		fp             = "abababababababababababababababababababababababababababababababab"
		// Independently computed with Python hashlib.
		keyHash = "bdaf76ae70b0ce3fc93a281afab76b7ffbcdc7b86c5b50754c23a28a1f53df27"
		digest  = "d06d14f61436b5f9ab8a14be789d4dc762ab7964975e1630ff380582c5629d19"
	)
	check := func(got, want string) {
		t.Helper()
		if got != want {
			t.Fatalf("\ngot  %s\nwant %s", got, want)
		}
	}
	check(string(KeygenKeyMessage(kg, parts[1].MemberID, 1, key)),
		"QDWallet-KeygenKey|v1|"+wallet+"|"+keygen+"|01900000-0000-7000-8000-000000000004|1|5|"+keyHash)
	check(hex.EncodeToString(EnvelopesDigest(parts)), digest)
	check(string(KeygenDealMessage(kg, kg.Fingerprint, EnvelopesDigest(parts))),
		"QDWallet-KeygenDeal|v1|"+wallet+"|"+keygen+"|5|2|3|"+fp+"|"+digest)
	check(string(KeygenAckMessage(kg, parts[0], kg.Fingerprint)),
		"QDWallet-KeygenAck|v1|"+wallet+"|"+keygen+"|01900000-0000-7000-8000-000000000006|3|2|3|5|"+fp+"|"+strings.Repeat("03", 32))
}
