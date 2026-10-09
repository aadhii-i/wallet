// Package postgres implements internal/store.Store on PostgreSQL via pgx.
// Every user-owned query includes a user_id predicate (defence in depth
// alongside Postgres RLS, which is configured at the database/ops level and
// out of scope for this package). Queries are hand-written (no sqlc binary
// available in this environment); see the README for that deviation.
package postgres

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Users() store.Users                   { return &usersRepo{pool: s.pool} }
func (s *Store) Devices() store.Devices               { return &devicesRepo{pool: s.pool} }
func (s *Store) Challenges() store.Challenges         { return &challengesRepo{pool: s.pool} }
func (s *Store) Sessions() store.Sessions             { return &sessionsRepo{pool: s.pool} }
func (s *Store) RefreshTokens() store.RefreshTokens   { return &refreshTokensRepo{pool: s.pool} }
func (s *Store) Wallets() store.Wallets               { return &walletsRepo{pool: s.pool} }
func (s *Store) Accounts() store.Accounts             { return &accountsRepo{pool: s.pool} }
func (s *Store) Addresses() store.Addresses           { return &addressesRepo{pool: s.pool} }
func (s *Store) Transactions() store.Transactions     { return &transactionsRepo{pool: s.pool} }
func (s *Store) SecurityEvents() store.SecurityEvents { return &securityEventsRepo{pool: s.pool} }
func (s *Store) AuditLogs() store.AuditLogs           { return &auditLogsRepo{pool: s.pool} }
func (s *Store) Idempotency() store.Idempotency       { return &idempotencyRepo{pool: s.pool} }

func (s *Store) Close() { s.pool.Close() }

var _ store.Store = (*Store)(nil)
