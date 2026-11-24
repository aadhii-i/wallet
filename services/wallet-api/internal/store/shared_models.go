package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Shared wallets (multi-participant approval). These are deliberately
// separate from Wallet/Account: a Wallet is one user's HD profile, while a
// SharedWallet is owned jointly by its participants (SharedMember). Creating
// an HD account never creates a participant and vice versa.

var (
	// ErrStale: the caller's view of the wallet (membership version) is out of date.
	ErrStale = errors.New("store: stale membership version")
	// ErrNonceInvalid: vote nonce unknown, used, expired, or bound to someone else.
	ErrNonceInvalid = errors.New("store: invalid vote nonce")
	// ErrProposalClosed: the proposal no longer accepts votes.
	ErrProposalClosed = errors.New("store: proposal is not open for votes")
	// ErrNotEligible: voter is not an active participant in the proposal's snapshot.
	ErrNotEligible = errors.New("store: participant not eligible")
	// ErrLimit: a capacity limit (e.g. 64 participants) would be exceeded.
	ErrLimit = errors.New("store: limit reached")
	// ErrInvitationInvalid: invitation unknown, expired, revoked or already used.
	ErrInvitationInvalid = errors.New("store: invitation invalid")
)

type MemberStatus string

const (
	MemberActive    MemberStatus = "active"
	MemberSuspended MemberStatus = "suspended"
	MemberRevoked   MemberStatus = "revoked"
)

type MemberRole string

const (
	RoleOwner  MemberRole = "owner"
	RoleMember MemberRole = "member"
)

type InvitationStatus string

const (
	InvitationInvited  InvitationStatus = "invited"
	InvitationAccepted InvitationStatus = "accepted"
	InvitationRejected InvitationStatus = "rejected"
	InvitationRevoked  InvitationStatus = "revoked"
)

// KeyStatus tracks whether a Threshold Raccoon key matching the current
// membership exists. Only a completed dealer ceremony may set "active".
type KeyStatus string

const (
	KeyNone          KeyStatus = "none"
	KeyRekeyRequired KeyStatus = "rekey_required"
	KeyActive        KeyStatus = "active"
)

type SharedWallet struct {
	ID                uuid.UUID
	Name              string
	CreatedBy         uuid.UUID // user id
	PolicyVersion     int
	PolicyNumerator   int
	PolicyDenominator int
	PolicyRounding    string
	// MembershipVersion increments on every join or revocation.
	MembershipVersion int64
	KeyStatus         KeyStatus
	// KeyGenerationID and KeyFingerprint identify the completed ceremony that
	// produced the current (or, after a membership change, the stale) key.
	KeyGenerationID *uuid.UUID
	KeyFingerprint  []byte
	CreatedAt       time.Time
}

// SharedMember is a participant: an independently authenticated user, bound
// to the device key that accepted the invitation. Votes must be signed by it.
type SharedMember struct {
	ID              uuid.UUID // participant id
	WalletID        uuid.UUID
	UserID          uuid.UUID
	DeviceID        uuid.UUID
	DevicePublicKey []byte // SPKI DER, copied from devices at join time
	DisplayName     string
	Role            MemberRole
	Status          MemberStatus
	InvitedBy       *uuid.UUID
	JoinedAt        time.Time
	RevokedAt       *time.Time
	RevokedBy       *uuid.UUID
}

type SharedInvitation struct {
	ID         uuid.UUID
	WalletID   uuid.UUID
	CodeHash   []byte // SHA-256 of the one-time code; the code itself is never stored
	Label      string
	InvitedBy  uuid.UUID // member id
	Status     InvitationStatus
	ExpiresAt  time.Time
	CreatedAt  time.Time
	ResolvedAt *time.Time
	ResolvedBy *uuid.UUID // user id that accepted or rejected
	MemberID   *uuid.UUID // set on accept
}

// SharedAccount is a wallet-level QD account: a derivation index under the
// wallet's Threshold Raccoon key. It has no Ethereum address until a
// smart-account verifier exists.
type SharedAccount struct {
	ID              uuid.UUID
	WalletID        uuid.UUID
	Name            string
	DerivationIndex int64
	CreatedBy       uuid.UUID // member id
	CreatedAt       time.Time
}

type ProposalStatus string

const (
	ProposalPending    ProposalStatus = "pending"
	ProposalApproved   ProposalStatus = "approved" // threshold reached
	ProposalRejected   ProposalStatus = "rejected" // threshold unreachable
	ProposalExpired    ProposalStatus = "expired"
	ProposalSuperseded ProposalStatus = "superseded" // membership changed before signing
)

// Proposal is immutable after creation except for Status/DecidedAt.
type Proposal struct {
	ID                   uuid.UUID
	WalletID             uuid.UUID
	AccountID            uuid.UUID
	DerivationIndex      int64
	InitiatorMemberID    uuid.UUID
	ChainID              int64
	To                   string // lowercase 0x address
	ValueWei             string // decimal
	Data                 string // lowercase 0x hex
	Nonce                uint64
	GasLimit             uint64
	MaxFeePerGas         string // decimal wei
	MaxPriorityFeePerGas string // decimal wei
	PolicyVersion        int
	PolicyNumerator      int
	PolicyDenominator    int
	PolicyRounding       string
	MembershipVersion    int64
	ParticipantCount     int
	RequiredApprovals    int
	EligibleMemberIDs    []uuid.UUID // participant snapshot, sorted
	Digest               []byte      // SHA-256 of the canonical encoding
	Status               ProposalStatus
	ExpiresAt            time.Time
	CreatedAt            time.Time
	DecidedAt            *time.Time
}

type VoteDecision string

const (
	VoteApprove VoteDecision = "approve"
	VoteReject  VoteDecision = "reject"
)

type Vote struct {
	ID         uuid.UUID
	ProposalID uuid.UUID
	MemberID   uuid.UUID
	Decision   VoteDecision
	Nonce      string
	IssuedAt   time.Time
	Signature  []byte // P1363 P-256 over the canonical vote message
	Digest     []byte // proposal digest the vote is bound to
	CreatedAt  time.Time
}

// VoteNonce is a single-use, short-lived challenge bound to one member and proposal.
type VoteNonce struct {
	Nonce      string
	ProposalID uuid.UUID
	MemberID   uuid.UUID
	ExpiresAt  time.Time
	UsedAt     *time.Time
	CreatedAt  time.Time
}

type SigningJobStatus string

const (
	// SigningAwaitingKey: approved, but no Threshold Raccoon key generation
	// matches the proposal's membership snapshot, so signing cannot start.
	SigningAwaitingKey SigningJobStatus = "awaiting_key_generation"
)

// SigningJob is created exactly once, when a proposal first reaches its threshold.
type SigningJob struct {
	ID         uuid.UUID
	ProposalID uuid.UUID
	Status     SigningJobStatus
	// Signers are the first RequiredApprovals approvers in vote order: the
	// signing protocol takes exactly T signers (ADR 0014 §7).
	Signers   []uuid.UUID
	CreatedAt time.Time
}

// DecideFunc maps vote counts to a proposal status; it is called inside the
// store's atomic section so the evaluation and the transition cannot race.
type DecideFunc func(p *Proposal, approvals, rejections int) (ProposalStatus, error)

type SharedWallets interface {
	SharedKeygens
	SharedSigning

	// CreateWallet inserts the wallet and its owner member together.
	CreateWallet(ctx context.Context, w *SharedWallet, owner *SharedMember) error
	GetWallet(ctx context.Context, walletID uuid.UUID) (*SharedWallet, error)
	// ListWalletsForUser returns wallets where userID is an active member.
	ListWalletsForUser(ctx context.Context, userID uuid.UUID) ([]*SharedWallet, error)

	ListMembers(ctx context.Context, walletID uuid.UUID) ([]*SharedMember, error)
	// GetActiveMemberByUser returns ErrNotFound unless userID is an active member.
	GetActiveMemberByUser(ctx context.Context, walletID, userID uuid.UUID) (*SharedMember, error)
	// RevokeMember marks the member revoked, bumps MembershipVersion, marks the
	// key as needing a rekey, and supersedes open proposals, atomically.
	RevokeMember(ctx context.Context, walletID, memberID, revokedBy uuid.UUID, now time.Time) (*SharedWallet, error)

	CreateInvitation(ctx context.Context, inv *SharedInvitation, maxOpen int) error
	ListInvitations(ctx context.Context, walletID uuid.UUID) ([]*SharedInvitation, error)
	GetInvitationByCodeHash(ctx context.Context, codeHash []byte) (*SharedInvitation, error)
	// AcceptInvitation consumes an open invitation and adds member, with the
	// same membership-change side effects as RevokeMember.
	AcceptInvitation(ctx context.Context, codeHash []byte, member *SharedMember, maxMembers int, now time.Time) (*SharedWallet, error)
	RejectInvitation(ctx context.Context, codeHash []byte, userID uuid.UUID, now time.Time) error
	RevokeInvitation(ctx context.Context, walletID, invitationID uuid.UUID, now time.Time) error

	CreateAccount(ctx context.Context, a *SharedAccount) error
	ListAccounts(ctx context.Context, walletID uuid.UUID) ([]*SharedAccount, error)
	GetAccount(ctx context.Context, walletID, accountID uuid.UUID) (*SharedAccount, error)

	// CreateProposal fails with ErrStale if the wallet's MembershipVersion no
	// longer equals p.MembershipVersion.
	CreateProposal(ctx context.Context, p *Proposal) error
	GetProposal(ctx context.Context, proposalID uuid.UUID) (*Proposal, error)
	ListProposals(ctx context.Context, walletID uuid.UUID) ([]*Proposal, error)
	// ExpireProposal moves a pending proposal past its expiry to expired.
	ExpireProposal(ctx context.Context, proposalID uuid.UUID, now time.Time) error

	CreateVoteNonce(ctx context.Context, n *VoteNonce) error
	// CastVote atomically: claims the nonce, checks the proposal is pending
	// and unexpired, checks the voter is active and in the snapshot, inserts
	// the vote (one per member), recounts, applies decide, and on the first
	// transition to approved creates the signing job.
	CastVote(ctx context.Context, v *Vote, now time.Time, decide DecideFunc) (*Proposal, error)
	ListVotes(ctx context.Context, proposalID uuid.UUID) ([]*Vote, error)
	GetSigningJob(ctx context.Context, proposalID uuid.UUID) (*SigningJob, error)
}
