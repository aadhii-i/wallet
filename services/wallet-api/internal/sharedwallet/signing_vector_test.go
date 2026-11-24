package sharedwallet

import (
	"encoding/hex"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Pinned with packages/rpc/test/shared-signing.test.ts: the browser must
// compute exactly the header, transcript hash and signed round message.
func TestSigningMessageVectors(t *testing.T) {
	u := func(s string) uuid.UUID { return uuid.MustParse(s) }
	b := func(n int, v byte) []byte {
		out := make([]byte, n)
		for i := range out {
			out[i] = v
		}
		return out
	}
	ss := &store.SigningSession{
		ID: u("01900000-0000-7000-8000-0000000000a1"), ProposalID: u("01900000-0000-7000-8000-0000000000a2"),
		WalletID: u("01900000-0000-7000-8000-0000000000a3"), KeygenID: u("01900000-0000-7000-8000-0000000000a4"),
		SID: b(32, 0x5a), Act: []int{1, 3}, SignerMemberIDs: []uuid.UUID{u("01900000-0000-7000-8000-0000000000b1"), u("01900000-0000-7000-8000-0000000000b3")},
		Threshold: 2, Parties: 3, MembershipVersion: 4, DerivationIndex: 0, ChainID: 31337,
		AccountAddress: "0xef2d12c08016fe0e3af45d10de2f1c88b61e2aa4", PublicKeyHash: b(32, 0x11), Message: b(32, 0x22),
		ExpiresAt: time.Unix(1_800_000_000, 0),
	}
	digest := b(32, 0x33)
	msgs := []*store.SigningMessage{
		{Round: 1, PartyIndex: 3, Payload: []byte("r1-p3")},
		{Round: 1, PartyIndex: 1, Payload: []byte("r1-p1")},
		{Round: 2, PartyIndex: 1, Payload: []byte("r2-p1")},
	}
	h := sha256Hex(SessionHeader(ss, digest))
	tr := hex.EncodeToString(TranscriptHash(ss, digest, msgs, 2))
	rm := sha256Hex(SignRoundMessage(ss, 2, 3, ss.SignerMemberIDs[1], TranscriptHash(ss, digest, msgs, 2), []byte("r2-p3")))
	t.Logf("header=%s transcript=%s round=%s", h, tr, rm)
	if h != "f79880c595d31fb091ed867e0900982ef9e30520dd32d6c72629f750ff676ab0" || tr != "dcc971af4a59dcdc644c5e7a2cae40fab84ae6a6d07f68839db98acd156707f7" || rm != "62b14f1724376e9dbf523a576e616128ec645f60bccedb9a91ac08bb0b5e961d" {
		t.Fatal("vectors changed")
	}
}
