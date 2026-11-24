// Package authorization holds the approval policy for shared wallets: how many
// of a wallet's active participants must approve a transaction proposal.
//
// This is an approval (coordination) policy only. It is not a cryptographic
// threshold: a QD key's signing threshold is fixed by the dealerKeyGen(T, N)
// run that created it and does not change when this policy or the membership
// changes. Use QdCompatibility to check whether a snapshot can be backed by a
// Threshold Raccoon key at all.
package authorization

import (
	"errors"
	"fmt"
)

// Rounding is how a fractional required-approval count is turned into an integer.
type Rounding string

// RoundCeil rounds up, so "1/2 of 5" requires 3 approvals, never 2.
const RoundCeil Rounding = "ceil"

// MaxParticipants bounds the participant count this package accepts, keeping
// count × numerator far from integer overflow. It is unrelated to the QD key
// limit (see QdMaxParties).
const MaxParticipants = 10_000

// QdMaxParties mirrors MAX_PARTIES in packages/qd-crypto/src/params.ts. The
// dealer's pairwise seeds grow as N², and ADR 0014 caps N at 64.
const QdMaxParties = 64

var (
	ErrInvalidPolicy        = errors.New("authorization: invalid policy")
	ErrNoActiveParticipants = errors.New("authorization: wallet has no active participants")
	ErrTooManyParticipants  = errors.New("authorization: participant count out of range")
	ErrQdUnsupportedConfig  = errors.New("authorization: configuration cannot be backed by a QD threshold key")
)

// Policy is a versioned approval ratio. Version identifies the rule set, not
// the wallet's membership; membership changes are tracked separately and
// captured in a Snapshot.
type Policy struct {
	Version     int      `json:"version"`
	Numerator   int      `json:"numerator"`
	Denominator int      `json:"denominator"`
	Rounding    Rounding `json:"rounding"`
}

// DefaultPolicy is the initial rule: at least half of the active participants.
func DefaultPolicy() Policy {
	return Policy{Version: 1, Numerator: 1, Denominator: 2, Rounding: RoundCeil}
}

// Validate accepts ratios in (0, 1] with ceil rounding. Ratios above 1 could
// never be met, and other rounding rules are not defined yet.
func (p Policy) Validate() error {
	switch {
	case p.Version < 1:
		return fmt.Errorf("%w: version must be >= 1", ErrInvalidPolicy)
	case p.Denominator < 1 || p.Denominator > MaxParticipants:
		return fmt.Errorf("%w: denominator out of range", ErrInvalidPolicy)
	case p.Numerator < 1 || p.Numerator > p.Denominator:
		return fmt.Errorf("%w: ratio must be in (0, 1]", ErrInvalidPolicy)
	case p.Rounding != RoundCeil:
		return fmt.Errorf("%w: unsupported rounding %q", ErrInvalidPolicy, p.Rounding)
	}
	return nil
}

// RequiredApprovals returns ceil(activeParticipants × Numerator / Denominator).
// The result is always in [1, activeParticipants].
func (p Policy) RequiredApprovals(activeParticipants int) (int, error) {
	if err := p.Validate(); err != nil {
		return 0, err
	}
	if activeParticipants < 1 {
		return 0, ErrNoActiveParticipants
	}
	if activeParticipants > MaxParticipants {
		return 0, ErrTooManyParticipants
	}
	// Integer ceil division; both operands are bounded, so no overflow.
	product := activeParticipants * p.Numerator
	return (product + p.Denominator - 1) / p.Denominator, nil
}

// Snapshot freezes the policy and membership a proposal is evaluated against.
// It is stored with the proposal and never recomputed, so later membership or
// policy changes cannot alter an already-submitted proposal.
type Snapshot struct {
	Policy            Policy `json:"policy"`
	MembershipVersion int64  `json:"membershipVersion"`
	ParticipantCount  int    `json:"participantCount"`
	RequiredApprovals int    `json:"requiredApprovals"`
}

// NewSnapshot computes the required approvals for the current membership.
func NewSnapshot(p Policy, membershipVersion int64, activeParticipants int) (Snapshot, error) {
	required, err := p.RequiredApprovals(activeParticipants)
	if err != nil {
		return Snapshot{}, err
	}
	if membershipVersion < 1 {
		return Snapshot{}, fmt.Errorf("%w: membership version must be >= 1", ErrInvalidPolicy)
	}
	return Snapshot{
		Policy:            p,
		MembershipVersion: membershipVersion,
		ParticipantCount:  activeParticipants,
		RequiredApprovals: required,
	}, nil
}

// Validate re-checks a stored snapshot, e.g. one loaded from the database.
func (s Snapshot) Validate() error {
	required, err := s.Policy.RequiredApprovals(s.ParticipantCount)
	if err != nil {
		return err
	}
	if required != s.RequiredApprovals {
		return fmt.Errorf("%w: stored required approvals %d, policy gives %d", ErrInvalidPolicy, s.RequiredApprovals, required)
	}
	if s.MembershipVersion < 1 {
		return fmt.Errorf("%w: membership version must be >= 1", ErrInvalidPolicy)
	}
	return nil
}

// Outcome is the state of a proposal's vote count against its snapshot.
type Outcome string

const (
	OutcomePending  Outcome = "pending"
	OutcomeApproved Outcome = "approved"
	// OutcomeRejected means the threshold can no longer be reached: even if
	// every participant who has not voted approves, approvals stay below the
	// requirement. A rejection is a negative vote, not a veto.
	OutcomeRejected Outcome = "rejected"
)

// Evaluate classifies valid, distinct votes against the snapshot. Callers
// must only pass votes that were authenticated, bound to the proposal digest,
// cast by participants in the snapshot, and not expired or revoked.
func (s Snapshot) Evaluate(approvals, rejections int) (Outcome, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	if approvals < 0 || rejections < 0 || approvals+rejections > s.ParticipantCount {
		return "", fmt.Errorf("%w: vote counts out of range", ErrInvalidPolicy)
	}
	if approvals >= s.RequiredApprovals {
		return OutcomeApproved, nil
	}
	if s.ParticipantCount-rejections < s.RequiredApprovals {
		return OutcomeRejected, nil
	}
	return OutcomePending, nil
}

// QdCompatibility reports whether a Threshold Raccoon key generated by
// dealerKeyGen(T, N) can back this snapshot with T = RequiredApprovals and
// N = ParticipantCount. qd-crypto accepts 1 <= T <= N <= 64, and a signing
// session takes exactly T signers (ADR 0014 §7).
//
// T = 1 is accepted by the protocol, but then every share equals the master
// secret (degree-0 Shamir polynomial), so each participant can sign alone.
// That matches a 1-of-N policy, and callers should say so to users.
func (s Snapshot) QdCompatibility() error {
	if err := s.Validate(); err != nil {
		return err
	}
	if s.ParticipantCount > QdMaxParties {
		return fmt.Errorf("%w: %d participants exceeds the QD limit of %d", ErrQdUnsupportedConfig, s.ParticipantCount, QdMaxParties)
	}
	return nil
}
