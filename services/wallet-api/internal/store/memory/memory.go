// Package memory implements internal/store.Store entirely in-process. It is
// the default store (STORE=memory) and is used by every unit/integration
// test that does not require TEST_DATABASE_URL.
package memory

import (
	"github.com/qdwallet/wallet-api/internal/store"
)

type Store struct {
	users         *userStore
	devices       *deviceStore
	challenges    *challengeStore
	sessions      *sessionStore
	refreshTokens *refreshTokenStore
	wallets       *walletStore
	accounts      *accountStore
	addresses     *addressStore
	txs           *txStore
	secEvents     *securityEventStore
	audit         *auditStore
	idem          *idempotencyStore
}

func New() *Store {
	return &Store{
		users:         &userStore{data: map[string]*store.User{}},
		devices:       &deviceStore{data: map[string]*store.Device{}},
		challenges:    &challengeStore{data: map[string]*store.Challenge{}},
		sessions:      &sessionStore{data: map[string]*store.Session{}},
		refreshTokens: newRefreshTokenStore(),
		wallets:       &walletStore{data: map[string]*store.Wallet{}},
		accounts:      &accountStore{data: map[string]*store.Account{}},
		addresses:     &addressStore{data: map[string]*store.Address{}},
		txs:           &txStore{data: map[string]*store.Transaction{}, events: map[string][]*store.TransactionEvent{}},
		secEvents:     &securityEventStore{data: map[string]*store.SecurityEvent{}},
		audit:         &auditStore{},
		idem:          &idempotencyStore{data: map[string]*store.IdempotencyRecord{}},
	}
}

func (s *Store) Users() store.Users                   { return s.users }
func (s *Store) Devices() store.Devices               { return s.devices }
func (s *Store) Challenges() store.Challenges         { return s.challenges }
func (s *Store) Sessions() store.Sessions             { return s.sessions }
func (s *Store) RefreshTokens() store.RefreshTokens   { return s.refreshTokens }
func (s *Store) Wallets() store.Wallets               { return s.wallets }
func (s *Store) Accounts() store.Accounts             { return s.accounts }
func (s *Store) Addresses() store.Addresses           { return s.addresses }
func (s *Store) Transactions() store.Transactions     { return s.txs }
func (s *Store) SecurityEvents() store.SecurityEvents { return s.secEvents }
func (s *Store) AuditLogs() store.AuditLogs           { return s.audit }
func (s *Store) Idempotency() store.Idempotency       { return s.idem }
func (s *Store) Close()                               {}

var _ store.Store = (*Store)(nil)
