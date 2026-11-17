// Package sharedwallet implements shared wallets: independent participants,
// invitations, transaction proposals and authenticated approvals evaluated
// against a frozen authorization-policy snapshot.
//
// Approvals are coordination, not cryptography. Reaching the threshold
// creates a signing job; it does not produce a Threshold Raccoon signature.
package sharedwallet

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// ProposalCanonicalString is the exact byte string whose SHA-256 is the
// proposal digest. Clients recompute it from the displayed fields and sign
// only the digest they computed themselves (mirrored in
// apps/web/src/lib/shared-wallets.ts). Every field is ASCII without '|'.
func ProposalCanonicalString(p *store.Proposal) string {
	ids := make([]string, len(p.EligibleMemberIDs))
	for i, id := range p.EligibleMemberIDs {
		ids[i] = id.String()
	}
	sort.Strings(ids)
	return strings.Join([]string{
		"QDWallet-Proposal", "v1",
		p.ID.String(), p.WalletID.String(), p.AccountID.String(),
		strconv.FormatInt(p.DerivationIndex, 10),
		p.InitiatorMemberID.String(),
		strconv.FormatInt(p.ChainID, 10),
		p.To, p.ValueWei, p.Data,
		strconv.FormatUint(p.Nonce, 10),
		strconv.FormatUint(p.GasLimit, 10),
		p.MaxFeePerGas, p.MaxPriorityFeePerGas,
		strconv.Itoa(p.PolicyVersion), strconv.Itoa(p.PolicyNumerator), strconv.Itoa(p.PolicyDenominator), p.PolicyRounding,
		strconv.FormatInt(p.MembershipVersion, 10),
		strconv.Itoa(p.ParticipantCount),
		strconv.Itoa(p.RequiredApprovals),
		strings.Join(ids, ","),
		strconv.FormatInt(p.ExpiresAt.Unix(), 10),
	}, "|")
}

func ProposalDigest(p *store.Proposal) []byte {
	d := sha256.Sum256([]byte(ProposalCanonicalString(p)))
	return d[:]
}

// VoteMessage is what a participant's device key signs. It binds the
// decision to the proposal digest, wallet, policy and membership versions,
// the participant, a single-use server nonce, and the signing time.
func VoteMessage(decision store.VoteDecision, p *store.Proposal, memberID uuid.UUID, nonce string, issuedAtUnix int64) []byte {
	return []byte(strings.Join([]string{
		"QDWallet-Vote", "v1",
		string(decision),
		p.ID.String(), p.WalletID.String(),
		hex.EncodeToString(p.Digest),
		strconv.Itoa(p.PolicyVersion),
		strconv.FormatInt(p.MembershipVersion, 10),
		memberID.String(),
		nonce,
		strconv.FormatInt(issuedAtUnix, 10),
	}, "|"))
}
