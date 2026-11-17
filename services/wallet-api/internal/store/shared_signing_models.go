package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Networked Threshold Raccoon signing (QD-Wallet Alg. 4) and on-chain
// execution for approved shared-wallet proposals. The backend coordinates:
// it relays the public round messages between the selected signers, combines
// the public transcript into one signature and verifies it, then a relayer
// submits it to the account's QdAccount contract. Key shares never reach it.

var (
	// ErrSigningClosed: the signing session is not open, not at this round, or expired.
	ErrSigningClosed = errors.New("store: signing session not open for this round")
	// ErrAlreadySigned: the proposal already has a completed signature.
	ErrAlreadySigned = errors.New("store: proposal already signed")
)

// AccountKey is a shared account's public Raccoon key pk_j (derivation index
// j under one key generation) and the QdAccount address derived from it.
// Participants' devices compute pk_j from their own share; the first
// registration is recorded and every later one must be identical.
type AccountKey struct {
	AccountID       uuid.UUID
	WalletID        uuid.UUID
	KeygenID        uuid.UUID
	DerivationIndex int64
	PublicKey       []byte // 5152 bytes: seedA ‖ t (k·n × u16)
	PublicKeyHash   []byte // keccak256("QD-VK-v1" ‖ pk)
	Address         string // lowercase 0x QdAccount address
	CreatedAt       time.Time
	Attestations    []AccountKeyAttestation
}

// AccountKeyAttestation: a participant's device computed the same pk_j from its share.
type AccountKeyAttestation struct {
	MemberID  uuid.UUID
	Signature []byte // P-256 over the account-key message
	At        time.Time
}

type SigningStatus string

const (
	SigningRound1    SigningStatus = "round1"    // collecting commitments
	SigningRound2    SigningStatus = "round2"    // collecting openings + MACs
	SigningRound3    SigningStatus = "round3"    // collecting response shares
	SigningCombining SigningStatus = "combining" // all responses in; combining and verifying
	SigningComplete  SigningStatus = "complete"  // one verified signature
	SigningFailed    SigningStatus = "failed"
)

func (s SigningStatus) Open() bool {
	return s == SigningRound1 || s == SigningRound2 || s == SigningRound3 || s == SigningCombining
}

// Round returns the round being collected (1–3), or 0.
func (s SigningStatus) Round() int {
	switch s {
	case SigningRound1:
		return 1
	case SigningRound2:
		return 2
	case SigningRound3:
		return 3
	}
	return 0
}

const (
	SigningFailExpired           = "expired"
	SigningFailCancelled         = "cancelled"
	SigningFailMembershipChanged = "membership_changed"
	SigningFailInvalidCommitment = "invalid_commitment"
	SigningFailInvalidSignature  = "invalid_signature"
	SigningFailParticipantAbort  = "participant_abort"
	SigningFailStateLost         = "signer_state_lost"
)

// SigningSession is one run of the three-round protocol for one proposal.
// SID is fresh, random and unique across all sessions; a failed session is
// never resumed, only replaced by a new session with a new SID.
type SigningSession struct {
	ID                uuid.UUID
	ProposalID        uuid.UUID
	WalletID          uuid.UUID
	KeygenID          uuid.UUID
	Attempt           int
	SID               []byte // 32 bytes
	Act               []int  // signer party indices, strictly increasing (|Act| = T)
	SignerMemberIDs   []uuid.UUID
	Threshold         int
	Parties           int
	MembershipVersion int64
	DerivationIndex   int64
	ChainID           int64
	AccountAddress    string
	PublicKeyHash     []byte
	Message           []byte // the 32-byte QdAccount execution message
	Status            SigningStatus
	FailureReason     string
	FailedBy          *uuid.UUID // member who reported a failure, if any
	Signature         []byte     // 19 494 bytes, once complete
	CreatedAt         time.Time
	ExpiresAt         time.Time
	EndedAt           *time.Time
}

// SigningMessage is one signer's message for one round, authenticated by
// that signer's device key over the transcript so far.
type SigningMessage struct {
	SessionID       uuid.UUID
	Round           int
	PartyIndex      int
	MemberID        uuid.UUID
	Payload         []byte
	DeviceSignature []byte
	CreatedAt       time.Time
}

type ExecutionStatus string

const (
	ExecPending    ExecutionStatus = "pending"    // verified signature, waiting for the relayer
	ExecSubmitting ExecutionStatus = "submitting" // relayer preparing chain state / sending
	ExecSubmitted  ExecutionStatus = "submitted"  // transaction broadcast, awaiting receipt
	ExecConfirmed  ExecutionStatus = "confirmed"  // receipt status 1 and Executed(success = true)
	ExecFailed     ExecutionStatus = "failed"     // reverted, inner call failed, expired, …
)

// Execution tracks the on-chain submission of a proposal's signature.
type Execution struct {
	ProposalID     uuid.UUID
	SessionID      uuid.UUID
	WalletID       uuid.UUID
	ChainID        int64
	AccountAddress string
	Status         ExecutionStatus
	LastError      string // why the relayer is waiting or failed (no secrets)
	RelayerAddress string
	TxHash         string
	RawTx          []byte // signed relayer transaction, kept for rebroadcast
	BlockNumber    *uint64
	GasUsed        *uint64
	CallSuccess    *bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
	SubmittedAt    *time.Time
	ConfirmedAt    *time.Time

	// Stage refines Status for the UI and diagnostics (see ExecStage*).
	Stage string
	// One-time chain setup, persisted so a restart resumes instead of repeating.
	SetupAttempts  int        // setup transactions mined but reverted (each cost gas)
	NextAttemptAt  *time.Time // the relayer leaves the execution alone until then
	SetupTxs       []string   // setup transactions mined successfully, in order
	PendingSetupTx string     // a setup transaction sent but not yet mined
	// Receipt details of the execute transaction (from the chain, never inferred).
	TxNonce           *uint64    // relayer transaction nonce
	EffectiveGasPrice string     // wei, decimal
	BlockTime         *time.Time // block timestamp
	ExecutedTo        string     // from QdAccount.Executed
	ExecutedValue     string     // wei, decimal, from QdAccount.Executed
}

// Execution stages: what the relayer is doing or waiting for.
const (
	ExecStageQueued             = "queued"
	ExecStageRelayerUnavailable = "relayer_unavailable" // no RPC/relayer key for the chain, or RPC chain mismatch
	ExecStageCheckingRelayer    = "checking_relayer"
	ExecStageAccountFunds       = "insufficient_account_funds"
	ExecStageRelayerFunds       = "insufficient_relayer_funds"
	ExecStageSettingUpVerifier  = "setting_up_verifier" // deploying verifier/factory, expanding the public matrix
	ExecStagePreparingAccount   = "preparing_account"   // deploying the QdAccount
	ExecStageWaitingNonce       = "waiting_nonce"       // an earlier proposal must execute first
	ExecStageSubmitting         = "submitting"
	ExecStageSubmitted          = "submitted"
	ExecStageConfirmed          = "confirmed"
	ExecStageFailed             = "failed"
	ExecStageExpired            = "expired" // valid-until passed before submission; nothing was sent
)

// SharedSigning is implemented by the same store as SharedWallets so that
// membership changes, proposal state and signing state commit together.
type SharedSigning interface {
	// PutAccountKey records pk for (account, keygen) or, if the same pk is
	// already recorded, adds the attestation (idempotent per member). A
	// different pk fails with ErrMismatch.
	PutAccountKey(ctx context.Context, k *AccountKey, att AccountKeyAttestation) (*AccountKey, error)
	GetAccountKey(ctx context.Context, accountID, keygenID uuid.UUID) (*AccountKey, error)

	// CreateSigningSession inserts a session for an approved proposal.
	// ErrConflict if a session is open, ErrAlreadySigned if one completed,
	// ErrStale if the wallet's active key or membership no longer match.
	CreateSigningSession(ctx context.Context, s *SigningSession) error
	GetSigningSession(ctx context.Context, sessionID uuid.UUID, now time.Time) (*SigningSession, []*SigningMessage, error)
	// LatestSigningSession returns the proposal's most recent session (ErrNotFound if none).
	LatestSigningSession(ctx context.Context, proposalID uuid.UUID, now time.Time) (*SigningSession, []*SigningMessage, error)
	// AddSigningMessage appends m if the session is open at round m.Round and
	// m is the first message from that party in that round (ErrConflict
	// otherwise). check runs under the same lock with the session and its
	// messages; if it returns a failure reason the session is failed with it
	// and ErrSigningClosed is returned. The last message of a round advances
	// the session (round 3 → combining).
	AddSigningMessage(ctx context.Context, m *SigningMessage, now time.Time,
		check func(s *SigningSession, msgs []*SigningMessage) (failReason string)) (*SigningSession, error)
	// CompleteSigningSession stores the verified signature, moves a
	// combining session to complete and creates the pending execution, atomically.
	CompleteSigningSession(ctx context.Context, sessionID uuid.UUID, signature []byte, now time.Time) (*SigningSession, error)
	// FailSigningSession ends an open session.
	FailSigningSession(ctx context.Context, sessionID uuid.UUID, reason string, by *uuid.UUID, now time.Time) (*SigningSession, error)

	GetExecution(ctx context.Context, proposalID uuid.UUID) (*Execution, error)
	// ListExecutions returns executions in any of the given statuses.
	ListExecutions(ctx context.Context, statuses []ExecutionStatus) ([]*Execution, error)
	// UpdateExecution replaces the execution if its current status is `from`
	// (ErrConflict otherwise), so concurrent relayers cannot double-submit.
	UpdateExecution(ctx context.Context, e *Execution, from ExecutionStatus) error

	// RecordGasTransfer inserts a gas-service transfer, or fills in the
	// proposal link and kind of an already recorded one (keyed by chain and
	// transaction hash). Recorded facts (value, fee, block) never change.
	RecordGasTransfer(ctx context.Context, t *GasTransfer) error
	// ListGasTransfers returns the newest transfers of one gas-service
	// address on one chain, newest block first.
	ListGasTransfers(ctx context.Context, chainID int64, address string, limit int) ([]*GasTransfer, error)
}

// Gas-service transfer directions and kinds.
const (
	GasIn  = "in"
	GasOut = "out"

	GasKindRecharge         = "recharge"          // ordinary transaction sending ETH to the gas service account
	GasKindRechargeInternal = "recharge_internal" // balance increase from a contract call (no direct transaction)
	GasKindSetup            = "setup"             // one-time verifier / matrix / account setup paid by the relayer
	GasKindExecute          = "execute"           // QdAccount.execute submitted by the relayer
	GasKindOther            = "other"             // any other transaction sent from the gas service account
)

// GasTransfer is one mined transaction (or, for recharge_internal, one block)
// that changed a gas-service account's balance, read from chain receipts.
type GasTransfer struct {
	ChainID      int64
	TxHash       string // lower-case; "internal:<block>" for recharge_internal
	Address      string // the gas service (relayer) address, lower-case
	Direction    string
	Kind         string
	Counterparty string // sender of a recharge, recipient (contract) of a payment
	ValueWei     string
	GasUsed      uint64
	GasPriceWei  string // effective gas price (outgoing only)
	FeeWei       string // gasUsed × effective gas price (outgoing only)
	Success      bool
	BlockNumber  uint64
	BlockTime    time.Time
	ProposalID   *uuid.UUID
	CreatedAt    time.Time
}
