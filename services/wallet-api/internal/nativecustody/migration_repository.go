package nativecustody

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrMigrationConflict = invalid("migration changed or another migration already protects this group")

type MigrationRepository struct {
	pool     *pgxpool.Pool
	mu       sync.Mutex
	snapshot string
	items    map[string]Migration
}

func NewMigrationRepository(pool *pgxpool.Pool, snapshot string) (*MigrationRepository, error) {
	r := &MigrationRepository{pool: pool, snapshot: snapshot, items: map[string]Migration{}}
	if pool == nil && snapshot != "" {
		body, err := os.ReadFile(snapshot)
		if err == nil {
			if err = json.Unmarshal(body, &r.items); err != nil {
				return nil, invalid("invalid native migration snapshot")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return r, nil
}
func cloneMigration(m Migration) Migration {
	body, _ := json.Marshal(m)
	var out Migration
	_ = json.Unmarshal(body, &out)
	return out
}
func (r *MigrationRepository) persistLocked() error {
	if r.snapshot == "" {
		return nil
	}
	body, err := json.Marshal(r.items)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(r.snapshot), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(r.snapshot+".tmp", body, 0600); err != nil {
		return err
	}
	return os.Rename(r.snapshot+".tmp", r.snapshot)
}
func (r *MigrationRepository) List(ctx context.Context) ([]Migration, error) {
	if r.pool != nil {
		rows, err := r.pool.Query(ctx, "SELECT body FROM native_wallet_migrations ORDER BY created_at")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Migration{}
		for rows.Next() {
			var body []byte
			var m Migration
			if err = rows.Scan(&body); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(body, &m); err != nil {
				return nil, err
			}
			out = append(out, m)
		}
		return out, rows.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Migration{}
	for _, m := range r.items {
		out = append(out, cloneMigration(m))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}
func (r *MigrationRepository) Get(ctx context.Context, id string) (Migration, error) {
	if r.pool != nil {
		var body []byte
		if err := r.pool.QueryRow(ctx, "SELECT body FROM native_wallet_migrations WHERE id=$1", id).Scan(&body); err != nil {
			return Migration{}, err
		}
		var out Migration
		err := json.Unmarshal(body, &out)
		return out, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.items[id]
	if !ok {
		return Migration{}, pgx.ErrNoRows
	}
	return cloneMigration(m), nil
}
func (r *MigrationRepository) Create(ctx context.Context, m Migration) error {
	if r.pool != nil {
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		wallets := []string{m.Manifest.SourceWalletID, m.Manifest.TargetWalletID}
		sort.Strings(wallets)
		for _, id := range wallets {
			if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "native-migration|"+id); err != nil {
				return err
			}
		}
		var count int
		err = tx.QueryRow(ctx, "SELECT count(*) FROM native_wallet_migrations WHERE status<>'cancelled' AND (source_wallet_id=$1 OR (status<>'complete' AND (source_wallet_id=$2 OR target_wallet_id IN ($1,$2))))", m.Manifest.SourceWalletID, m.Manifest.TargetWalletID).Scan(&count)
		if err != nil {
			return err
		}
		if count > 0 {
			return ErrMigrationConflict
		}
		body, _ := json.Marshal(m)
		_, err = tx.Exec(ctx, "INSERT INTO native_wallet_migrations(id,source_wallet_id,target_wallet_id,status,body,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$6)", m.Manifest.ID, m.Manifest.SourceWalletID, m.Manifest.TargetWalletID, m.Status, body, m.CreatedAt)
		if err != nil {
			return ErrMigrationConflict
		}
		return tx.Commit(ctx)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, old := range r.items {
		if old.Status == "cancelled" {
			continue
		}
		if old.Manifest.SourceWalletID == m.Manifest.SourceWalletID || old.Status != "complete" && (old.Manifest.SourceWalletID == m.Manifest.TargetWalletID || old.Manifest.TargetWalletID == m.Manifest.SourceWalletID || old.Manifest.TargetWalletID == m.Manifest.TargetWalletID) {
			return ErrMigrationConflict
		}
	}
	r.items[m.Manifest.ID] = cloneMigration(m)
	if err := r.persistLocked(); err != nil {
		delete(r.items, m.Manifest.ID)
		return err
	}
	return nil
}
func (r *MigrationRepository) Update(ctx context.Context, id string, revision int64, change func(*Migration) error) (Migration, error) {
	if r.pool != nil {
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return Migration{}, err
		}
		defer tx.Rollback(ctx)
		var body []byte
		if err = tx.QueryRow(ctx, "SELECT body FROM native_wallet_migrations WHERE id=$1 FOR UPDATE", id).Scan(&body); err != nil {
			return Migration{}, err
		}
		var m Migration
		if err = json.Unmarshal(body, &m); err != nil {
			return Migration{}, err
		}
		if m.Revision != revision {
			return Migration{}, ErrMigrationConflict
		}
		if err = change(&m); err != nil {
			return Migration{}, err
		}
		m.Revision++
		body, _ = json.Marshal(m)
		if _, err = tx.Exec(ctx, "UPDATE native_wallet_migrations SET status=$2,body=$3,updated_at=$4 WHERE id=$1", id, m.Status, body, m.UpdatedAt); err != nil {
			return Migration{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return Migration{}, err
		}
		return m, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	old, ok := r.items[id]
	if !ok {
		return Migration{}, pgx.ErrNoRows
	}
	m := cloneMigration(old)
	if m.Revision != revision {
		return Migration{}, ErrMigrationConflict
	}
	if err := change(&m); err != nil {
		return Migration{}, err
	}
	m.Revision++
	r.items[id] = m
	if err := r.persistLocked(); err != nil {
		r.items[id] = old
		return Migration{}, err
	}
	return cloneMigration(m), nil
}

func (r *MigrationRepository) ForWallet(ctx context.Context, walletID string) ([]Migration, error) {
	if r.pool != nil {
		rows, err := r.pool.Query(ctx, "SELECT body FROM native_wallet_migrations WHERE source_wallet_id=$1 OR target_wallet_id=$1 ORDER BY created_at", walletID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Migration{}
		for rows.Next() {
			var body []byte
			var m Migration
			if err = rows.Scan(&body); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(body, &m); err != nil {
				return nil, err
			}
			out = append(out, m)
		}
		return out, rows.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Migration{}
	for _, m := range r.items {
		if m.Manifest.SourceWalletID == walletID || m.Manifest.TargetWalletID == walletID {
			out = append(out, cloneMigration(m))
		}
	}
	return out, nil
}
