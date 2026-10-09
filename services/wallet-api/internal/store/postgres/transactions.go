package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type transactionsRepo struct{ pool *pgxpool.Pool }

const txCols = `id, user_id, account_id, network_id, hash, from_address, to_address, asset_id, amount, fee, nonce, status, block_number, origin, flags, created_at, updated_at`

func (r *transactionsRepo) Create(ctx context.Context, t *store.Transaction) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO transactions
		(id, user_id, account_id, network_id, hash, from_address, to_address, asset_id, amount, fee, nonce, status, block_number, origin, flags, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		t.ID, t.UserID, t.AccountID, t.NetworkID, t.Hash, t.From, t.To, t.AssetID, t.Amount, t.Fee, t.Nonce,
		string(t.Status), t.BlockNumber, string(t.Origin), t.Flags, t.CreatedAt, t.UpdatedAt)
	return mapConflict(err)
}

func scanTx(row pgx.Row) (*store.Transaction, error) {
	var t store.Transaction
	var status, origin string
	if err := row.Scan(&t.ID, &t.UserID, &t.AccountID, &t.NetworkID, &t.Hash, &t.From, &t.To, &t.AssetID, &t.Amount,
		&t.Fee, &t.Nonce, &status, &t.BlockNumber, &origin, &t.Flags, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	t.Status = store.TxStatus(status)
	t.Origin = store.TxOrigin(origin)
	return &t, nil
}

func (r *transactionsRepo) GetByNetworkAndHash(ctx context.Context, userID uuid.UUID, networkID, hash string) (*store.Transaction, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+txCols+` FROM transactions WHERE user_id=$1 AND network_id=$2 AND hash=$3`, userID, networkID, hash)
	return scanTx(row)
}

func (r *transactionsRepo) Get(ctx context.Context, userID, id uuid.UUID) (*store.Transaction, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+txCols+` FROM transactions WHERE id=$1 AND user_id=$2`, id, userID)
	return scanTx(row)
}

func (r *transactionsRepo) Update(ctx context.Context, t *store.Transaction) error {
	tag, err := r.pool.Exec(ctx, `UPDATE transactions SET status=$1, block_number=$2, fee=$3, flags=$4, updated_at=now() WHERE id=$5`,
		string(t.Status), t.BlockNumber, t.Fee, t.Flags, t.ID)
	if err != nil {
		return err
	}
	return rowsAffectedOrNotFound(tag.RowsAffected())
}

func (r *transactionsRepo) ListPending(ctx context.Context) ([]*store.Transaction, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+txCols+` FROM transactions WHERE status='pending'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Transaction
	for rows.Next() {
		t, err := scanTx(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *transactionsRepo) AddEvent(ctx context.Context, e *store.TransactionEvent) error {
	var fromStatus *string
	if e.FromStatus != nil {
		s := string(*e.FromStatus)
		fromStatus = &s
	}
	_, err := r.pool.Exec(ctx, `INSERT INTO transaction_events (id, transaction_id, from_status, to_status, detail, observed_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		e.ID, e.TransactionID, fromStatus, string(e.ToStatus), e.Detail, e.ObservedAt)
	return err
}

func (r *transactionsRepo) ListEvents(ctx context.Context, transactionID uuid.UUID) ([]*store.TransactionEvent, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, transaction_id, from_status, to_status, detail, observed_at
		FROM transaction_events WHERE transaction_id=$1 ORDER BY observed_at`, transactionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.TransactionEvent
	for rows.Next() {
		var e store.TransactionEvent
		var fromStatus *string
		var toStatus string
		if err := rows.Scan(&e.ID, &e.TransactionID, &fromStatus, &toStatus, &e.Detail, &e.ObservedAt); err != nil {
			return nil, err
		}
		if fromStatus != nil {
			s := store.TxStatus(*fromStatus)
			e.FromStatus = &s
		}
		e.ToStatus = store.TxStatus(toStatus)
		out = append(out, &e)
	}
	return out, rows.Err()
}

func (r *transactionsRepo) ListByAccount(ctx context.Context, userID, accountID uuid.UUID, networkID string) ([]*store.Transaction, error) {
	query := `SELECT ` + txCols + ` FROM transactions WHERE user_id=$1 AND account_id=$2`
	args := []any{userID, accountID}
	if networkID != "" {
		query += ` AND network_id=$3`
		args = append(args, networkID)
	}
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Transaction
	for rows.Next() {
		t, err := scanTx(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
