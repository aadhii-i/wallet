package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Threshold Raccoon key generation for a shared wallet (trusted dealer, QD-Wallet
// Alg. 1). The backend coordinates the ceremony and relays HPKE envelopes; it
// never sees a plaintext share, the master secret, tFull or the chain code. It
// stores only: public X-Wing encryption keys, opaque envelopes (deleted once the
// recipient acknowledges or the ceremony ends), and the master-key fingerprint.

var (
	// ErrKeygenClosed: the ceremony is not in the state the operation needs, or it expired.
	ErrKeygenClosed = errors.New("store: key generation not open for this step")
	// ErrKeygenIncomplete: not every participant has the required input yet.
	ErrKeygenIncomplete = errors.New("store: key generation incomplete")
	// ErrMismatch: a value does not match what this ceremony committed to.
	ErrMismatch = errors.New("store: value does not match the key generation")
)

type KeygenStatus string

const (
	// KeygenCollectingKeys: participants register per-ceremony X-Wing encryption keys.
	KeygenCollectingKeys KeygenStatus = "collecting_keys"
	// KeygenDealing: all keys registered; the dealer uploads one envelope per participant.
	KeygenDealing KeygenStatus = "dealing"
	// KeygenAwaitingProvisioning: envelopes committed; each participant decrypts, verifies and acknowledges.
	KeygenAwaitingProvisioning KeygenStatus = "awaiting_provisioning"
	// KeygenComplete: every participant acknowledged the same fingerprint.
	KeygenComplete KeygenStatus = "complete"
	// KeygenFailed: cancelled, expired, membership changed, or a participant reported a failure.
	KeygenFailed KeygenStatus = "failed"
)

func (s KeygenStatus) Open() bool {
	return s == KeygenCollectingKeys || s == KeygenDealing || s == KeygenAwaitingProvisioning
}

const (
	KeygenFailCancelled         = "cancelled"
	KeygenFailExpired           = "expired"
	KeygenFailMembershipChanged = "membership_changed"
	KeygenFailDecryption        = "decryption_failed"
	KeygenFailVerification      = "share_verification_failed"
)

type KeyGeneration struct {
	ID                uuid.UUID
	WalletID          uuid.UUID
	MembershipVersion int64 // must equal the wallet's for the whole ceremony
	Threshold         int
	Parties           int
	DealerMemberID    uuid.UUID
	Status            KeygenStatus
	FailureReason     string
	Fingerprint       []byte // SHA3-256 master-key fingerprint, set when envelopes are committed
	DealerSignature   []byte // dealer device signature over the deal commitment
	CreatedAt         time.Time
	ExpiresAt         time.Time
	EndedAt           *time.Time
}

// KeygenParticipant is one party slot. PartyIndex is the Shamir evaluation point i.
type KeygenParticipant struct {
	KeygenID        uuid.UUID
	MemberID        uuid.UUID
	PartyIndex      int
	EncryptionKey   []byte // X-Wing public key (1216 bytes)
	KeySignature    []byte // device signature over the key registration message
	KeyRegisteredAt *time.Time
	// Envelope: staged by the dealer, committed with the deal, wiped after the
	// participant acknowledges or the ceremony ends. EnvelopeHash is kept.
	EnvelopeEnc         []byte
	EnvelopeCT          []byte
	EnvelopeHash        []byte // SHA-256(enc ‖ ct)
	EnvelopeFingerprint []byte // fingerprint the staged envelope was produced under
	AckSignature        []byte
	ProvisionedAt       *time.Time
}

// SharedKeygens is implemented by the same store as SharedWallets so that a
// membership change and the ceremony state change commit together.
type SharedKeygens interface {
	// CreateKeyGeneration fails with ErrStale if the wallet's membership
	// version moved, and ErrConflict if a ceremony is already open or the
	// wallet already has an active key.
	CreateKeyGeneration(ctx context.Context, kg *KeyGeneration, parts []*KeygenParticipant) error
	GetKeyGeneration(ctx context.Context, keygenID uuid.UUID) (*KeyGeneration, []*KeygenParticipant, error)
	// LatestKeyGeneration returns the most recent ceremony for the wallet, or ErrNotFound.
	LatestKeyGeneration(ctx context.Context, walletID uuid.UUID) (*KeyGeneration, []*KeygenParticipant, error)
	// RegisterEncryptionKey records a participant's key (once); when the last
	// participant registers, the ceremony moves to dealing.
	RegisterEncryptionKey(ctx context.Context, keygenID, memberID uuid.UUID, key, sig []byte, now time.Time) (*KeyGeneration, error)
	// StageEnvelope stores or replaces one participant's envelope while dealing.
	StageEnvelope(ctx context.Context, keygenID, memberID uuid.UUID, fingerprint, enc, ct []byte, now time.Time) error
	// CommitDeal requires one staged envelope per participant, all under
	// fingerprint; it then moves the ceremony to awaiting_provisioning.
	CommitDeal(ctx context.Context, keygenID uuid.UUID, fingerprint, dealerSig []byte, now time.Time) (*KeyGeneration, error)
	// AckProvisioning marks one participant provisioned (ErrConflict if already),
	// wipes their envelope, and when every participant has acknowledged,
	// completes the ceremony and activates the wallet key — atomically.
	AckProvisioning(ctx context.Context, keygenID, memberID uuid.UUID, fingerprint, sig []byte, now time.Time) (*KeyGeneration, error)
	// FailKeyGeneration ends an open ceremony and wipes every envelope.
	FailKeyGeneration(ctx context.Context, keygenID uuid.UUID, reason string, now time.Time) (*KeyGeneration, error)
}
