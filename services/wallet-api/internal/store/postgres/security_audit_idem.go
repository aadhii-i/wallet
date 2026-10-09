package postgres

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/audit"
	"github.com/qdwallet/wallet-api/internal/store"
)

type securityEventsRepo struct{ pool *pgxpool.Pool }

func (r *securityEventsRepo) Create(ctx context.Context, e *store.SecurityEvent) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO security_events (id, user_id, device_id, type, severity, ip_hash, metadata, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		e.ID, e.UserID, e.DeviceID, e.Type, string(e.Severity), e.IPHash, e.Metadata, e.CreatedAt)
	return err
}

func (r *securityEventsRepo) ListByUser(ctx context.Context, userID uuid.UUID, limit int) ([]*store.SecurityEvent, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, user_id, device_id, type, severity, ip_hash, metadata, acknowledged_at, created_at
		FROM security_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.SecurityEvent
	for rows.Next() {
		var e store.SecurityEvent
		var severity string
		if err := rows.Scan(&e.ID, &e.UserID, &e.DeviceID, &e.Type, &severity, &e.IPHash, &e.Metadata, &e.AcknowledgedAt, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Severity = store.Severity(severity)
		out = append(out, &e)
	}
	return out, rows.Err()
}

// auditLogsRepo serializes Append with a process-local mutex in addition to
// relying on the database row ordering, since two concurrent appends must
// never compute their row_hash from the same prev_hash.
type auditLogsRepo struct {
	pool *pgxpool.Pool
	mu   sync.Mutex
}

func (r *auditLogsRepo) Append(ctx context.Context, entry *store.AuditLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	var prevHash []byte
	row := r.pool.QueryRow(ctx, `SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1`)
	if err := row.Scan(&prevHash); err != nil {
		prevHash = nil // no rows yet
	}
	entry.PrevHash = prevHash
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}
	hash, err := audit.RowHash(prevHash, entry)
	if err != nil {
		return err
	}
	entry.RowHash = hash

	return r.pool.QueryRow(ctx, `INSERT INTO audit_logs (actor_type, actor_id, action, subject_type, subject_id, metadata, prev_hash, row_hash, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		entry.ActorType, entry.ActorID, entry.Action, entry.SubjectType, entry.SubjectID, entry.Metadata, entry.PrevHash, entry.RowHash, entry.CreatedAt,
	).Scan(&entry.ID)
}

func (r *auditLogsRepo) List(ctx context.Context, limit int) ([]*store.AuditLog, error) {
	query := `SELECT id, actor_type, actor_id, action, subject_type, subject_id, metadata, prev_hash, row_hash, created_at FROM audit_logs ORDER BY id`
	if limit > 0 {
		query += ` DESC LIMIT ` + itoaLimit(limit)
	}
	rows, err := r.pool.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.AuditLog
	for rows.Next() {
		var e store.AuditLog
		if err := rows.Scan(&e.ID, &e.ActorType, &e.ActorID, &e.Action, &e.SubjectType, &e.SubjectID, &e.Metadata, &e.PrevHash, &e.RowHash, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &e)
	}
	if limit > 0 {
		// reverse back to ascending order
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out, rows.Err()
}

func (r *auditLogsRepo) VerifyChain(ctx context.Context) error {
	all, err := r.List(ctx, 0)
	if err != nil {
		return err
	}
	return audit.VerifyChain(all)
}

func itoaLimit(n int) string {
	if n <= 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

type idempotencyRepo struct{ pool *pgxpool.Pool }

func (r *idempotencyRepo) Get(ctx context.Context, userID uuid.UUID, key, route string) (*store.IdempotencyRecord, error) {
	row := r.pool.QueryRow(ctx, `SELECT key, user_id, route, status_code, body, created_at
		FROM idempotency_keys WHERE user_id=$1 AND route=$2 AND key=$3`, userID, route, key)
	var rec store.IdempotencyRecord
	if err := row.Scan(&rec.Key, &rec.UserID, &rec.Route, &rec.StatusCode, &rec.Body, &rec.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	return &rec, nil
}

func (r *idempotencyRepo) Put(ctx context.Context, rec *store.IdempotencyRecord) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO idempotency_keys (key, user_id, route, status_code, body, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id, route, key) DO NOTHING`,
		rec.Key, rec.UserID, rec.Route, rec.StatusCode, rec.Body, rec.CreatedAt)
	return err
}
