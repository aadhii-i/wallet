package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type walletsRepo struct{ pool *pgxpool.Pool }

func (r *walletsRepo) Create(ctx context.Context, w *store.Wallet) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO wallets (id, user_id, label, default_signing_mode, created_at) VALUES ($1,$2,$3,$4,$5)`,
		w.ID, w.UserID, w.Label, string(w.DefaultSigningMode), w.CreatedAt)
	return err
}

func scanWallet(row pgx.Row) (*store.Wallet, error) {
	var w store.Wallet
	var mode string
	if err := row.Scan(&w.ID, &w.UserID, &w.Label, &mode, &w.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	w.DefaultSigningMode = store.SigningMode(mode)
	return &w, nil
}

const walletCols = `id, user_id, label, default_signing_mode, created_at`

func (r *walletsRepo) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Wallet, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+walletCols+` FROM wallets WHERE user_id=$1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Wallet
	for rows.Next() {
		w, err := scanWallet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (r *walletsRepo) Get(ctx context.Context, userID, walletID uuid.UUID) (*store.Wallet, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+walletCols+` FROM wallets WHERE id=$1 AND user_id=$2`, walletID, userID)
	return scanWallet(row)
}

type accountsRepo struct{ pool *pgxpool.Pool }

func (r *accountsRepo) Create(ctx context.Context, a *store.Account) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO accounts (id, wallet_id, user_id, hd_index, name, signing_mode, hidden, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		a.ID, a.WalletID, a.UserID, a.HDIndex, a.Name, string(a.SigningMode), a.Hidden, a.CreatedAt)
	return mapConflict(err)
}

const accountCols = `id, wallet_id, user_id, hd_index, name, signing_mode, hidden, created_at`

func scanAccount(row pgx.Row) (*store.Account, error) {
	var a store.Account
	var mode string
	if err := row.Scan(&a.ID, &a.WalletID, &a.UserID, &a.HDIndex, &a.Name, &mode, &a.Hidden, &a.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	a.SigningMode = store.SigningMode(mode)
	return &a, nil
}

func (r *accountsRepo) Get(ctx context.Context, userID, accountID uuid.UUID) (*store.Account, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+accountCols+` FROM accounts WHERE id=$1 AND user_id=$2`, accountID, userID)
	return scanAccount(row)
}

func (r *accountsRepo) ListByWallet(ctx context.Context, userID, walletID uuid.UUID) ([]*store.Account, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+accountCols+` FROM accounts WHERE user_id=$1 AND wallet_id=$2 ORDER BY created_at`, userID, walletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *accountsRepo) ListByUser(ctx context.Context, userID uuid.UUID) ([]*store.Account, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+accountCols+` FROM accounts WHERE user_id=$1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *accountsRepo) Update(ctx context.Context, userID, accountID uuid.UUID, name *string, hidden *bool) (*store.Account, error) {
	_, err := r.pool.Exec(ctx, `UPDATE accounts SET
			name = COALESCE($1, name),
			hidden = COALESCE($2, hidden)
		WHERE id=$3 AND user_id=$4`, name, hidden, accountID, userID)
	if err != nil {
		return nil, err
	}
	return r.Get(ctx, userID, accountID)
}

type addressesRepo struct{ pool *pgxpool.Pool }

func (r *addressesRepo) Create(ctx context.Context, a *store.Address) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO addresses (id, account_id, network_family, address, created_at) VALUES ($1,$2,$3,$4,$5)`,
		a.ID, a.AccountID, string(a.NetworkFamily), a.Address, a.CreatedAt)
	return mapConflict(err)
}

func scanAddress(row pgx.Row) (*store.Address, error) {
	var a store.Address
	var family string
	if err := row.Scan(&a.ID, &a.AccountID, &family, &a.Address, &a.CreatedAt); err != nil {
		return nil, mapNotFound(err)
	}
	a.NetworkFamily = store.NetworkFamily(family)
	return &a, nil
}

func (r *addressesRepo) ListByAccount(ctx context.Context, userID, accountID uuid.UUID) ([]*store.Address, error) {
	rows, err := r.pool.Query(ctx, `SELECT a.id, a.account_id, a.network_family, a.address, a.created_at
		FROM addresses a JOIN accounts acc ON acc.id = a.account_id
		WHERE a.account_id=$1 AND acc.user_id=$2 ORDER BY a.created_at`, accountID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Address
	for rows.Next() {
		a, err := scanAddress(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *addressesRepo) ListByAccounts(ctx context.Context, userID uuid.UUID, accountIDs []uuid.UUID) ([]*store.Address, error) {
	if len(accountIDs) == 0 {
		return nil, nil
	}
	rows, err := r.pool.Query(ctx, `SELECT a.id, a.account_id, a.network_family, a.address, a.created_at
		FROM addresses a JOIN accounts acc ON acc.id = a.account_id
		WHERE acc.user_id=$1 AND a.account_id = ANY($2) ORDER BY a.created_at`, userID, accountIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.Address
	for rows.Next() {
		a, err := scanAddress(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
