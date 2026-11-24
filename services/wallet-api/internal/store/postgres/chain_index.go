package postgres

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type chainIndexRepo struct{ pool *pgxpool.Pool }

func (r *chainIndexRepo) RecordTransfer(ctx context.Context, t *store.ChainTransfer) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO chain_transfers
		(chain_id, tx_hash, log_index, kind, from_address, to_address, token, amount, tx_from, tx_to, success, block_number, block_time, gas_used, gas_price_wei, fee_wei)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
		t.ChainID, strings.ToLower(t.TxHash), t.LogIndex, t.Kind, t.From, t.To, t.Token, t.Amount, t.TxFrom, t.TxTo, t.Success,
		int64(t.BlockNumber), t.BlockTime, int64(t.GasUsed), t.GasPriceWei, t.FeeWei)
	return err
}

func (r *chainIndexRepo) ListTransfers(ctx context.Context, chainID int64, addresses []string, limit int) ([]*store.ChainTransfer, error) {
	if limit <= 0 {
		limit = 1000
	}
	lower := make([]string, len(addresses))
	for i, a := range addresses {
		lower[i] = strings.ToLower(a)
	}
	rows, err := r.pool.Query(ctx, `SELECT chain_id, tx_hash, log_index, kind, from_address, to_address, token, amount::text, tx_from, tx_to,
		success, block_number, block_time, gas_used, gas_price_wei, fee_wei, created_at
		FROM chain_transfers
		WHERE chain_id = $1 AND (from_address = ANY($2) OR to_address = ANY($2) OR tx_from = ANY($2))
		ORDER BY block_number DESC, tx_hash, log_index LIMIT $3`, chainID, lower, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.ChainTransfer
	for rows.Next() {
		var t store.ChainTransfer
		var block, gas int64
		if err := rows.Scan(&t.ChainID, &t.TxHash, &t.LogIndex, &t.Kind, &t.From, &t.To, &t.Token, &t.Amount, &t.TxFrom, &t.TxTo,
			&t.Success, &block, &t.BlockTime, &gas, &t.GasPriceWei, &t.FeeWei, &t.CreatedAt); err != nil {
			return nil, err
		}
		t.BlockNumber, t.GasUsed = uint64(block), uint64(gas)
		out = append(out, &t)
	}
	return out, rows.Err()
}

func (r *chainIndexRepo) GetCursor(ctx context.Context, chainID int64, address string) (*store.IndexCursor, error) {
	var c store.IndexCursor
	var since, through int64
	err := r.pool.QueryRow(ctx, `SELECT chain_id, address, since_block, scanned_through, updated_at FROM chain_index_cursors WHERE chain_id=$1 AND address=$2`,
		chainID, strings.ToLower(address)).Scan(&c.ChainID, &c.Address, &since, &through, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, store.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.SinceBlock, c.ScannedThrough = uint64(since), uint64(through)
	return &c, nil
}

func (r *chainIndexRepo) PutCursor(ctx context.Context, c *store.IndexCursor) error {
	_, err := r.pool.Exec(ctx, `INSERT INTO chain_index_cursors (chain_id, address, since_block, scanned_through, updated_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (chain_id, address) DO UPDATE SET since_block = EXCLUDED.since_block, scanned_through = EXCLUDED.scanned_through, updated_at = now()`,
		c.ChainID, strings.ToLower(c.Address), int64(c.SinceBlock), int64(c.ScannedThrough))
	return err
}

func (r *chainIndexRepo) WatchedAddresses(ctx context.Context) ([]store.WatchedAddress, error) {
	rows, err := r.pool.Query(ctx, `SELECT DISTINCT ON (address) address, kind FROM (
		SELECT lower(address) AS address, 'personal' AS kind FROM addresses WHERE network_family = 'evm'
		UNION ALL
		SELECT lower(address), 'shared' FROM shared_account_keys
	) a ORDER BY address, kind`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.WatchedAddress
	for rows.Next() {
		var w store.WatchedAddress
		if err := rows.Scan(&w.Address, &w.Kind); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
