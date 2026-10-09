package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ErrNotFound is returned by repository lookups when a row does not exist,
// OR exists but is not owned by the caller's user_id. Handlers must map
// ErrNotFound to HTTP 404 in both cases (IDOR defence: never 403).
var ErrNotFound = errors.New("store: not found")

// ErrConflict is returned for unique-constraint violations (e.g. a device
// key that is already registered, or a duplicate (network,hash) tx).
var ErrConflict = errors.New("store: conflict")

type Users interface {
	Create(ctx context.Context, u *User) error
	Get(ctx context.Context, id uuid.UUID) (*User, error)
}

type Devices interface {
	Create(ctx context.Context, d *Device) error
	GetByPublicKey(ctx context.Context, publicKey []byte) (*Device, error)
	Get(ctx context.Context, userID, deviceID uuid.UUID) (*Device, error)
	GetByID(ctx context.Context, deviceID uuid.UUID) (*Device, error)
	ListByUser(ctx context.Context, userID uuid.UUID) ([]*Device, error)
	UpdateLabel(ctx context.Context, userID, deviceID uuid.UUID, label string) error
	Revoke(ctx context.Context, userID, deviceID uuid.UUID) error
	TouchLastSeen(ctx context.Context, deviceID uuid.UUID) error
}

type Challenges interface {
	Create(ctx context.Context, c *Challenge) error
	// Get is a read-only lookup (used to fetch the message/public key for
	// signature verification before consumption). It must NOT be used as
	// part of the single-use check -- see ClaimChallenge.
	Get(ctx context.Context, id uuid.UUID) (*Challenge, error)
	// ClaimChallenge atomically marks the challenge used, transitioning
	// used_at from NULL to now() in one operation (e.g. `UPDATE ... WHERE
	// id=$1 AND used_at IS NULL`). It returns the claimed row on success,
	// ErrConflict if the challenge exists but was already used, or
	// ErrNotFound if it does not exist. Callers must not call Get + a
	// separate "mark used" step, since that reintroduces a check-then-act
	// race between concurrent redemption attempts.
	ClaimChallenge(ctx context.Context, id uuid.UUID) (*Challenge, error)
}

type Sessions interface {
	Create(ctx context.Context, s *Session) error
	Get(ctx context.Context, id uuid.UUID) (*Session, error)
	ExtendExpiry(ctx context.Context, sessionID uuid.UUID, newExpiresAt time.Time) error
	Revoke(ctx context.Context, sessionID uuid.UUID) error
	RevokeByDevice(ctx context.Context, deviceID uuid.UUID) error
}

// RefreshTokens tracks refresh token rotation generations, keyed by the
// SHA-256 hash of the raw token. See store.RefreshToken for the reuse
// detection design.
type RefreshTokens interface {
	Create(ctx context.Context, rt *RefreshToken) error
	GetByHash(ctx context.Context, hash []byte) (*RefreshToken, error)
	// ClaimRotation atomically transitions rotated from false to true for
	// hash (e.g. `UPDATE ... WHERE hash=$1 AND rotated=false RETURNING
	// session_id`), so two concurrent refreshes with the same token can
	// never both succeed. claimed=true means the caller may proceed to
	// mint a new generation for sessionID. claimed=false with err=nil means
	// the hash exists but was already rotated (a replay -- the caller must
	// revoke sessionID's session and record a reuse event). err=ErrNotFound
	// means the hash is unknown.
	ClaimRotation(ctx context.Context, hash []byte) (sessionID uuid.UUID, claimed bool, err error)
}

type Wallets interface {
	Create(ctx context.Context, w *Wallet) error
	ListByUser(ctx context.Context, userID uuid.UUID) ([]*Wallet, error)
	Get(ctx context.Context, userID, walletID uuid.UUID) (*Wallet, error)
}

type Accounts interface {
	Create(ctx context.Context, a *Account) error
	Get(ctx context.Context, userID, accountID uuid.UUID) (*Account, error)
	ListByWallet(ctx context.Context, userID, walletID uuid.UUID) ([]*Account, error)
	ListByUser(ctx context.Context, userID uuid.UUID) ([]*Account, error)
	Update(ctx context.Context, userID, accountID uuid.UUID, name *string, hidden *bool) (*Account, error)
}

type Addresses interface {
	Create(ctx context.Context, a *Address) error
	ListByAccount(ctx context.Context, userID, accountID uuid.UUID) ([]*Address, error)
	ListByAccounts(ctx context.Context, userID uuid.UUID, accountIDs []uuid.UUID) ([]*Address, error)
}

type Transactions interface {
	Create(ctx context.Context, t *Transaction) error
	GetByNetworkAndHash(ctx context.Context, userID uuid.UUID, networkID, hash string) (*Transaction, error)
	Get(ctx context.Context, userID, id uuid.UUID) (*Transaction, error)
	Update(ctx context.Context, t *Transaction) error
	ListPending(ctx context.Context) ([]*Transaction, error)
	AddEvent(ctx context.Context, e *TransactionEvent) error
	ListEvents(ctx context.Context, transactionID uuid.UUID) ([]*TransactionEvent, error)
	ListByAccount(ctx context.Context, userID, accountID uuid.UUID, networkID string) ([]*Transaction, error)
}

type SecurityEvents interface {
	Create(ctx context.Context, e *SecurityEvent) error
	ListByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*SecurityEvent, error)
}

type AuditLogs interface {
	// Append writes the next row, computing PrevHash/RowHash from the
	// current chain head. Implementations must serialize this (a mutex or a
	// DB-level lock) so the chain never forks under concurrency.
	Append(ctx context.Context, entry *AuditLog) error
	List(ctx context.Context, limit int) ([]*AuditLog, error)
	// VerifyChain recomputes every row's hash and returns an error
	// describing the first mismatch, or nil if the chain is intact.
	VerifyChain(ctx context.Context) error
}

type Idempotency interface {
	Get(ctx context.Context, userID uuid.UUID, key, route string) (*IdempotencyRecord, error)
	Put(ctx context.Context, rec *IdempotencyRecord) error
}

// Store aggregates every repository. Concrete implementations (memory,
// postgres) implement the whole surface so the rest of the app can depend on
// one interface.
type Store interface {
	Users() Users
	Devices() Devices
	Challenges() Challenges
	Sessions() Sessions
	RefreshTokens() RefreshTokens
	Wallets() Wallets
	Accounts() Accounts
	Addresses() Addresses
	Transactions() Transactions
	SecurityEvents() SecurityEvents
	AuditLogs() AuditLogs
	Idempotency() Idempotency

	// Close releases any underlying resources (DB pool, etc).
	Close()
}
