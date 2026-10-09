package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type challengesRepo struct{ pool *pgxpool.Pool }

func (r *challengesRepo) Create(ctx context.Context, c *store.Challenge) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO challenges (id, public_key, nonce, message, origin, client_type, expires_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
		c.ID, c.PublicKey, c.Nonce, c.Message, c.Origin, c.ClientType, c.ExpiresAt, c.CreatedAt)
	return err
}

func (r *challengesRepo) Get(ctx context.Context, id uuid.UUID) (*store.Challenge, error) {
	row := r.pool.QueryRow(ctx, `SELECT id, public_key, nonce, message, origin, client_type, expires_at, used_at, created_at
		FROM challenges WHERE id=$1`, id)
	var c store.Challenge
	if err := row.Scan(&c.ID, &c.PublicKey, &c.Nonce, &c.Message, &c.Origin, &c.ClientType, &c.ExpiresAt, &c.UsedAt, &c.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	return &c, nil
}

// ClaimChallenge atomically marks the challenge used with a single
// UPDATE ... WHERE used_at IS NULL, so two concurrent redemption attempts
// can never both succeed. On a 0-row result we run a follow-up read (not
// part of the atomic path, purely for error classification) to tell
// "already used" apart from "never existed".
func (r *challengesRepo) ClaimChallenge(ctx context.Context, id uuid.UUID) (*store.Challenge, error) {
	row := r.pool.QueryRow(ctx, `UPDATE challenges SET used_at=$1 WHERE id=$2 AND used_at IS NULL
		RETURNING id, public_key, nonce, message, origin, client_type, expires_at, used_at, created_at`,
		time.Now().UTC(), id)
	var c store.Challenge
	err := row.Scan(&c.ID, &c.PublicKey, &c.Nonce, &c.Message, &c.Origin, &c.ClientType, &c.ExpiresAt, &c.UsedAt, &c.CreatedAt)
	if err == nil {
		return &c, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// 0 rows: either unknown or already used. Classify with a plain read.
	if _, getErr := r.Get(ctx, id); getErr == nil {
		return nil, store.ErrConflict
	}
	return nil, store.ErrNotFound
}

type sessionsRepo struct{ pool *pgxpool.Pool }

func (r *sessionsRepo) Create(ctx context.Context, s *store.Session) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO sessions (id, device_id, user_id, expires_at, ip_hash, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		s.ID, s.DeviceID, s.UserID, s.ExpiresAt, s.IPHash, s.CreatedAt)
	return err
}

func (r *sessionsRepo) Get(ctx context.Context, id uuid.UUID) (*store.Session, error) {
	row := r.pool.QueryRow(ctx, `SELECT id, device_id, user_id, expires_at, revoked_at, ip_hash, created_at
		FROM sessions WHERE id=$1`, id)
	var s store.Session
	if err := row.Scan(&s.ID, &s.DeviceID, &s.UserID, &s.ExpiresAt, &s.RevokedAt, &s.IPHash, &s.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	return &s, nil
}

func (r *sessionsRepo) ExtendExpiry(ctx context.Context, sessionID uuid.UUID, newExpiresAt time.Time) error {
	tag, err := r.pool.Exec(ctx, `UPDATE sessions SET expires_at=$1 WHERE id=$2`, newExpiresAt, sessionID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func (r *sessionsRepo) Revoke(ctx context.Context, sessionID uuid.UUID) error {
	tag, err := r.pool.Exec(ctx, `UPDATE sessions SET revoked_at=$1 WHERE id=$2`, time.Now().UTC(), sessionID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func (r *sessionsRepo) RevokeByDevice(ctx context.Context, deviceID uuid.UUID) error {
	_, err := r.pool.Exec(ctx, `UPDATE sessions SET revoked_at=$1 WHERE device_id=$2 AND revoked_at IS NULL`, time.Now().UTC(), deviceID)
	return err
}

type refreshTokensRepo struct{ pool *pgxpool.Pool }

func (r *refreshTokensRepo) Create(ctx context.Context, rt *store.RefreshToken) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO refresh_tokens (hash, session_id, rotated, created_at) VALUES ($1,$2,$3,$4)`,
		rt.Hash, rt.SessionID, rt.Rotated, rt.CreatedAt)
	return err
}

func (r *refreshTokensRepo) GetByHash(ctx context.Context, hash []byte) (*store.RefreshToken, error) {
	row := r.pool.QueryRow(ctx, `SELECT hash, session_id, rotated, created_at FROM refresh_tokens WHERE hash=$1`, hash)
	var rt store.RefreshToken
	if err := row.Scan(&rt.Hash, &rt.SessionID, &rt.Rotated, &rt.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	return &rt, nil
}

// ClaimRotation atomically flips rotated false->true with a single UPDATE
// ... WHERE rotated=false, so two concurrent refreshes with the same raw
// token can never both win. A 0-row result on a hash that DOES exist means
// it was already rotated (replay); the follow-up read to fetch session_id
// for that case is not part of the atomic decision, only used to know which
// session to revoke/alert on.
func (r *refreshTokensRepo) ClaimRotation(ctx context.Context, hash []byte) (uuid.UUID, bool, error) {
	row := r.pool.QueryRow(ctx, `UPDATE refresh_tokens SET rotated=true WHERE hash=$1 AND rotated=false RETURNING session_id`, hash)
	var sessionID uuid.UUID
	err := row.Scan(&sessionID)
	if err == nil {
		return sessionID, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.UUID{}, false, err
	}
	existing, getErr := r.GetByHash(ctx, hash)
	if getErr != nil {
		return uuid.UUID{}, false, store.ErrNotFound
	}
	return existing.SessionID, false, nil
}
