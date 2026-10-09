// Package store defines the persistence-facing domain models and the
// repository interfaces implemented by internal/store/memory and
// internal/store/postgres. Every user-owned lookup takes a userID and must
// be scoped to it by the implementation (see each interface's doc comment).
package store

import (
	"time"

	"github.com/google/uuid"
)

type UserStatus string

const (
	UserActive  UserStatus = "active"
	UserLocked  UserStatus = "locked"
	UserDeleted UserStatus = "deleted"
)

type User struct {
	ID        uuid.UUID
	Email     *string
	Status    UserStatus
	CreatedAt time.Time
}

type Platform string

const (
	PlatformWeb     Platform = "web"
	PlatformIOS     Platform = "ios"
	PlatformAndroid Platform = "android"
)

type Device struct {
	ID         uuid.UUID
	UserID     uuid.UUID
	PublicKey  []byte // SPKI DER, P-256
	Platform   Platform
	Label      string
	LastSeenAt time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

// Session represents one device login. Its ID is stable across refresh
// token rotations and is the "sid" claim in access tokens. Refresh token
// material lives in RefreshToken rows (see below), keyed by the session's
// ID as the rotation "family".
type Session struct {
	ID        uuid.UUID
	DeviceID  uuid.UUID
	UserID    uuid.UUID
	ExpiresAt time.Time
	RevokedAt *time.Time
	IPHash    string
	CreatedAt time.Time
}

// RefreshToken is one generation of a session's refresh token. Only the
// SHA-256 hash of the raw token is ever stored. Rotated=true marks a
// superseded generation; presenting a rotated hash again means the token
// was replayed and the whole session (rotation family) must be revoked.
type RefreshToken struct {
	Hash      []byte
	SessionID uuid.UUID
	Rotated   bool
	CreatedAt time.Time
}

// Challenge is an issued auth challenge. Implementations may keep these in
// memory/Redis rather than Postgres since they are short-lived (60s TTL).
type Challenge struct {
	ID         uuid.UUID
	PublicKey  []byte
	Nonce      string
	Message    string
	Origin     string
	ClientType string // "web" | "mobile"
	ExpiresAt  time.Time
	UsedAt     *time.Time
	CreatedAt  time.Time
}

type SigningMode string

const (
	SigningHD  SigningMode = "hd"
	SigningMPC SigningMode = "mpc"
	SigningQD  SigningMode = "qd"
)

type Wallet struct {
	ID                 uuid.UUID
	UserID             uuid.UUID
	Label              string
	DefaultSigningMode SigningMode
	CreatedAt          time.Time
}

type Account struct {
	ID          uuid.UUID
	WalletID    uuid.UUID
	UserID      uuid.UUID
	HDIndex     *int64
	Name        string
	SigningMode SigningMode
	Hidden      bool
	CreatedAt   time.Time
}

type NetworkFamily string

const (
	FamilyEVM    NetworkFamily = "evm"
	FamilyMonero NetworkFamily = "monero"
)

type Address struct {
	ID            uuid.UUID
	AccountID     uuid.UUID
	NetworkFamily NetworkFamily
	Address       string // lowercase-normalised
	CreatedAt     time.Time
}

type TxStatus string

const (
	TxPending   TxStatus = "pending"
	TxConfirmed TxStatus = "confirmed"
	TxFailed    TxStatus = "failed"
	TxReplaced  TxStatus = "replaced"
	TxDropped   TxStatus = "dropped"
)

type TxOrigin string

const (
	OriginWallet  TxOrigin = "wallet"
	OriginIndexed TxOrigin = "indexed"
)

type Transaction struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	AccountID   uuid.UUID
	NetworkID   string
	Hash        string
	From        string
	To          string
	AssetID     string
	Amount      string // decimal string, base units
	Fee         *string
	Nonce       *int64
	Status      TxStatus
	BlockNumber *int64
	Origin      TxOrigin
	Flags       []string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type TransactionEvent struct {
	ID            uuid.UUID
	TransactionID uuid.UUID
	FromStatus    *TxStatus
	ToStatus      TxStatus
	Detail        map[string]any
	ObservedAt    time.Time
}

type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

type SecurityEvent struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	DeviceID       *uuid.UUID
	Type           string
	Severity       Severity
	IPHash         string
	Metadata       map[string]any
	AcknowledgedAt *time.Time
	CreatedAt      time.Time
}

type AuditLog struct {
	ID          int64
	ActorType   string
	ActorID     string
	Action      string
	SubjectType string
	SubjectID   string
	Metadata    map[string]any
	PrevHash    []byte
	RowHash     []byte
	CreatedAt   time.Time
}

// IdempotencyRecord stores the response of a previously handled request so
// a retried POST with the same Idempotency-Key returns the same result.
type IdempotencyRecord struct {
	Key        string
	UserID     uuid.UUID
	Route      string
	StatusCode int
	Body       []byte
	CreatedAt  time.Time
}
