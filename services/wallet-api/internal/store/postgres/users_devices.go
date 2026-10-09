package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type usersRepo struct{ pool *pgxpool.Pool }

func (r *usersRepo) Create(ctx context.Context, u *store.User) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO users (id, email, status, created_at) VALUES ($1,$2,$3,$4)`,
		u.ID, u.Email, string(u.Status), u.CreatedAt)
	return err
}

func (r *usersRepo) Get(ctx context.Context, id uuid.UUID) (*store.User, error) {
	row := r.pool.QueryRow(ctx, `SELECT id, email, status, created_at FROM users WHERE id=$1`, id)
	var u store.User
	var status string
	if err := row.Scan(&u.ID, &u.Email, &status, &u.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	u.Status = store.UserStatus(status)
	return &u, nil
}

type devicesRepo struct{ pool *pgxpool.Pool }

func (r *devicesRepo) Create(ctx context.Context, d *store.Device) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO devices (id, user_id, public_key, platform, label, last_seen_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		d.ID, d.UserID, d.PublicKey, string(d.Platform), d.Label, d.LastSeenAt, d.CreatedAt)
	return mapConflict(err)
}

func scanDevice(row pgx.Row) (*store.Device, error) {
	var d store.Device
	var platform string
	if err := row.Scan(&d.ID, &d.UserID, &d.PublicKey, &platform, &d.Label, &d.LastSeenAt, &d.RevokedAt, &d.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	d.Platform = store.Platform(platform)
	return &d, nil
}

const deviceCols = `id, user_id, public_key, platform, label, last_seen_at, revoked_at, created_at`

func (r *devicesRepo) GetByPublicKey(ctx context.Context, publicKey []byte) (*store.Device, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+deviceCols+` FROM devices WHERE public_key=$1`, publicKey)
	return scanDevice(row)
}

func (r *devicesRepo) Get(ctx context.Context, userID, deviceID uuid.UUID) (*store.Device, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+deviceCols+` FROM devices WHERE id=$1 AND user_id=$2`, deviceID, userID)
	return scanDevice(row)
}

func (r *devicesRepo) GetByID(ctx context.Context, deviceID uuid.UUID) (*store.Device, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+deviceCols+` FROM devices WHERE id=$1`, deviceID)
	return scanDevice(row)
}

func (r *devicesRepo) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Device, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+deviceCols+` FROM devices WHERE user_id=$1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Device
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (r *devicesRepo) UpdateLabel(ctx context.Context, userID, deviceID uuid.UUID, label string) error {
	tag, err := r.pool.Exec(ctx, `UPDATE devices SET label=$1 WHERE id=$2 AND user_id=$3`, label, deviceID, userID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func (r *devicesRepo) Revoke(ctx context.Context, userID, deviceID uuid.UUID) error {
	tag, err := r.pool.Exec(ctx, `UPDATE devices SET revoked_at=$1 WHERE id=$2 AND user_id=$3`, time.Now().UTC(), deviceID, userID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func (r *devicesRepo) TouchLastSeen(ctx context.Context, deviceID uuid.UUID) error {
	tag, err := r.pool.Exec(ctx, `UPDATE devices SET last_seen_at=$1 WHERE id=$2`, time.Now().UTC(), deviceID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func mapNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}

func mapConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return store.ErrConflict
	}
	return err
}

func rowsAffectedOrNotFound(n int64) error {
	if n == 0 {
		return store.ErrNotFound
	}
	return nil
}
