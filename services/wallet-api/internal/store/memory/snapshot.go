package memory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Snapshots make the development in-memory store survive API restarts
// (STORE_SNAPSHOT=path). Without them a restart loses every wallet, proposal,
// signing session and execution record, including setup and transaction
// history. Development only: config refuses STORE=memory in production.
//
// The file holds what the server already holds: no plaintext key shares
// (those never reach the server), device public keys, hashed refresh tokens,
// HPKE-encrypted share envelopes and public signing transcripts. It is written
// atomically with mode 0600.

type snapshot struct {
	Version       int
	SavedAt       time.Time
	Users         map[string]*store.User
	Devices       map[string]*store.Device
	Challenges    map[string]*store.Challenge
	Sessions      map[string]*store.Session
	RefreshTokens map[string]*store.RefreshToken
	Wallets       map[string]*store.Wallet
	Accounts      map[string]*store.Account
	Addresses     map[string]*store.Address
	Txs           map[string]*store.Transaction
	TxEvents      map[string][]*store.TransactionEvent
	SecEvents     map[string]*store.SecurityEvent
	Audit         []*store.AuditLog
	Idem          map[string]*store.IdempotencyRecord
	Shared        sharedSnapshot
	ChainIndex    chainIndexSnapshot
}

type chainIndexSnapshot struct {
	Transfers map[string]*store.ChainTransfer
	Cursors   map[string]*store.IndexCursor
}

type sharedSnapshot struct {
	Wallets      map[uuid.UUID]*store.SharedWallet
	Members      map[uuid.UUID]*store.SharedMember
	Invitations  map[uuid.UUID]*store.SharedInvitation
	Accounts     map[uuid.UUID]*store.SharedAccount
	Proposals    map[uuid.UUID]*store.Proposal
	Votes        map[uuid.UUID][]*store.Vote
	Nonces       map[string]*store.VoteNonce
	Jobs         map[uuid.UUID]*store.SigningJob
	Keygens      map[uuid.UUID]*store.KeyGeneration
	KeygenParts  map[uuid.UUID][]*store.KeygenParticipant
	AccountKeys  []*store.AccountKey // keyed by (AccountID, KeygenID) in memory
	Sessions     map[uuid.UUID]*store.SigningSession
	SessionMsgs  map[uuid.UUID][]*store.SigningMessage
	Sids         map[string]bool
	Executions   map[uuid.UUID]*store.Execution
	GasTransfers map[string]*store.GasTransfer
}

const snapshotVersion = 1

// marshal serialises the whole store. Each sub-store is copied under its own
// lock; the shared-wallet state (the one that must be consistent across
// proposals, sessions and executions) is copied under its single lock.
func (s *Store) marshal() ([]byte, error) {
	// Encode each part while holding its lock, then assemble.
	parts := map[string]json.RawMessage{}
	add := func(name string, lock func(), unlock func(), v any) error {
		lock()
		defer unlock()
		raw, err := json.Marshal(v)
		parts[name] = raw
		return err
	}
	steps := []error{
		add("Users", s.users.mu.RLock, s.users.mu.RUnlock, s.users.data),
		add("Devices", s.devices.mu.RLock, s.devices.mu.RUnlock, s.devices.data),
		add("Challenges", s.challenges.mu.Lock, s.challenges.mu.Unlock, s.challenges.data),
		add("Sessions", s.sessions.mu.Lock, s.sessions.mu.Unlock, s.sessions.data),
		add("RefreshTokens", s.refreshTokens.mu.Lock, s.refreshTokens.mu.Unlock, s.refreshTokens.data),
		add("Wallets", s.wallets.mu.RLock, s.wallets.mu.RUnlock, s.wallets.data),
		add("Accounts", s.accounts.mu.RLock, s.accounts.mu.RUnlock, s.accounts.data),
		add("Addresses", s.addresses.mu.RLock, s.addresses.mu.RUnlock, s.addresses.data),
		add("Txs", s.txs.mu.RLock, s.txs.mu.RUnlock, s.txs.data),
		add("TxEvents", s.txs.mu.RLock, s.txs.mu.RUnlock, s.txs.events),
		add("SecEvents", s.secEvents.mu.RLock, s.secEvents.mu.RUnlock, s.secEvents.data),
		add("Audit", s.audit.mu.Lock, s.audit.mu.Unlock, s.audit.entries),
		add("Idem", s.idem.mu.Lock, s.idem.mu.Unlock, s.idem.data),
	}
	sh := s.shared
	steps = append(steps, add("Shared", sh.mu.Lock, sh.mu.Unlock, func() sharedSnapshot {
		keys := make([]*store.AccountKey, 0, len(sh.accountKeys))
		for _, k := range sh.accountKeys {
			keys = append(keys, k)
		}
		return sharedSnapshot{
			Wallets: sh.wallets, Members: sh.members, Invitations: sh.invitations, Accounts: sh.accounts,
			Proposals: sh.proposals, Votes: sh.votes, Nonces: sh.nonces, Jobs: sh.jobs, Keygens: sh.keygens,
			KeygenParts: sh.keygenParts, AccountKeys: keys, Sessions: sh.sessions, SessionMsgs: sh.sessionMsgs,
			Sids: sh.sids, Executions: sh.executions, GasTransfers: sh.gasTransfers,
		}
	}()))
	ci := s.chainIndex
	steps = append(steps, add("ChainIndex", ci.mu.Lock, ci.mu.Unlock, chainIndexSnapshot{Transfers: ci.transfers, Cursors: ci.cursors}))
	if err := errors.Join(steps...); err != nil {
		return nil, err
	}
	parts["Version"], _ = json.Marshal(snapshotVersion)
	parts["SavedAt"], _ = json.Marshal(time.Now().UTC())
	return json.Marshal(parts)
}

// Load replaces the store's contents with the snapshot at path. A missing
// file is not an error (first start).
func (s *Store) Load(path string) (bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var snap snapshot
	if err := json.Unmarshal(b, &snap); err != nil {
		return false, fmt.Errorf("snapshot %s: %w", path, err)
	}
	if snap.Version != snapshotVersion {
		return false, fmt.Errorf("snapshot %s: unsupported version %d", path, snap.Version)
	}
	fresh := New()
	if snap.Users != nil {
		fresh.users.data = snap.Users
	}
	if snap.Devices != nil {
		fresh.devices.data = snap.Devices
	}
	if snap.Challenges != nil {
		fresh.challenges.data = snap.Challenges
	}
	if snap.Sessions != nil {
		fresh.sessions.data = snap.Sessions
	}
	if snap.RefreshTokens != nil {
		fresh.refreshTokens.data = snap.RefreshTokens
	}
	if snap.Wallets != nil {
		fresh.wallets.data = snap.Wallets
	}
	if snap.Accounts != nil {
		fresh.accounts.data = snap.Accounts
	}
	if snap.Addresses != nil {
		fresh.addresses.data = snap.Addresses
	}
	if snap.Txs != nil {
		fresh.txs.data = snap.Txs
	}
	if snap.TxEvents != nil {
		fresh.txs.events = snap.TxEvents
	}
	if snap.SecEvents != nil {
		fresh.secEvents.data = snap.SecEvents
	}
	fresh.audit.entries = snap.Audit
	if snap.Idem != nil {
		fresh.idem.data = snap.Idem
	}
	sh, in := fresh.shared, snap.Shared
	assign := func() {
		if in.Wallets != nil {
			sh.wallets = in.Wallets
		}
		if in.Members != nil {
			sh.members = in.Members
		}
		if in.Invitations != nil {
			sh.invitations = in.Invitations
		}
		if in.Accounts != nil {
			sh.accounts = in.Accounts
		}
		if in.Proposals != nil {
			sh.proposals = in.Proposals
		}
		if in.Votes != nil {
			sh.votes = in.Votes
		}
		if in.Nonces != nil {
			sh.nonces = in.Nonces
		}
		if in.Jobs != nil {
			sh.jobs = in.Jobs
		}
		if in.Keygens != nil {
			sh.keygens = in.Keygens
		}
		if in.KeygenParts != nil {
			sh.keygenParts = in.KeygenParts
		}
		for _, k := range in.AccountKeys {
			sh.accountKeys[[2]uuid.UUID{k.AccountID, k.KeygenID}] = k
		}
		if in.Sessions != nil {
			sh.sessions = in.Sessions
		}
		if in.SessionMsgs != nil {
			sh.sessionMsgs = in.SessionMsgs
		}
		if in.Sids != nil {
			sh.sids = in.Sids
		}
		if in.Executions != nil {
			sh.executions = in.Executions
		}
		if in.GasTransfers != nil {
			sh.gasTransfers = in.GasTransfers
		}
	}
	assign()
	if snap.ChainIndex.Transfers != nil {
		fresh.chainIndex.transfers = snap.ChainIndex.Transfers
	}
	if snap.ChainIndex.Cursors != nil {
		fresh.chainIndex.cursors = snap.ChainIndex.Cursors
	}
	*s = *fresh
	s.chainIndex.parent = s
	return true, nil
}

// Save writes the snapshot atomically (temp file + rename, mode 0600). It
// returns the content hash so callers can skip unchanged writes.
func (s *Store) Save(path string, lastHash [32]byte) ([32]byte, error) {
	b, err := s.marshal()
	if err != nil {
		return lastHash, err
	}
	// SavedAt changes every call; hash the content without it.
	h := sha256.Sum256(stripSavedAt(b))
	if h == lastHash {
		return h, nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return lastHash, err
	}
	tmp, err := os.CreateTemp(dir, ".snapshot-*")
	if err != nil {
		return lastHash, err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return lastHash, err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return lastHash, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return lastHash, err
	}
	if err := tmp.Close(); err != nil {
		return lastHash, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return lastHash, err
	}
	return h, nil
}

func stripSavedAt(b []byte) []byte {
	i := bytes.Index(b, []byte(`"SavedAt":"`))
	if i < 0 {
		return b
	}
	j := bytes.IndexByte(b[i+11:], '"')
	if j < 0 {
		return b
	}
	out := append([]byte(nil), b[:i]...)
	return append(out, b[i+11+j+1:]...)
}

// RunSnapshots saves every interval until ctx is done, then once more.
func (s *Store) RunSnapshots(ctx context.Context, path string, interval time.Duration, logger *slog.Logger) {
	var last [32]byte
	save := func() {
		h, err := s.Save(path, last)
		if err != nil {
			logger.Error("store snapshot failed", "path", path, "err", err)
			return
		}
		last = h
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			save()
			return
		case <-t.C:
			save()
		}
	}
}
