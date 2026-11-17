package memory

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

func cpAccountKey(k *store.AccountKey) *store.AccountKey {
	c := *k
	c.PublicKey = cpBytes(k.PublicKey)
	c.PublicKeyHash = cpBytes(k.PublicKeyHash)
	c.Attestations = make([]store.AccountKeyAttestation, len(k.Attestations))
	for i, a := range k.Attestations {
		c.Attestations[i] = store.AccountKeyAttestation{MemberID: a.MemberID, Signature: cpBytes(a.Signature), At: a.At}
	}
	return &c
}

func cpSession(ss *store.SigningSession) *store.SigningSession {
	c := *ss
	c.SID = cpBytes(ss.SID)
	c.Act = append([]int(nil), ss.Act...)
	c.SignerMemberIDs = append([]uuid.UUID(nil), ss.SignerMemberIDs...)
	c.PublicKeyHash = cpBytes(ss.PublicKeyHash)
	c.Message = cpBytes(ss.Message)
	c.Signature = cpBytes(ss.Signature)
	if ss.FailedBy != nil {
		id := *ss.FailedBy
		c.FailedBy = &id
	}
	if ss.EndedAt != nil {
		t := *ss.EndedAt
		c.EndedAt = &t
	}
	return &c
}

func cpMsgs(ms []*store.SigningMessage) []*store.SigningMessage {
	out := make([]*store.SigningMessage, len(ms))
	for i, m := range ms {
		c := *m
		c.Payload = cpBytes(m.Payload)
		c.DeviceSignature = cpBytes(m.DeviceSignature)
		out[i] = &c
	}
	return out
}

func cpExecution(e *store.Execution) *store.Execution {
	c := *e
	c.RawTx = cpBytes(e.RawTx)
	c.SetupTxs = append([]string(nil), e.SetupTxs...)
	for _, p := range []**time.Time{&c.SubmittedAt, &c.ConfirmedAt, &c.NextAttemptAt, &c.BlockTime} {
		if *p != nil {
			v := **p
			*p = &v
		}
	}
	for _, p := range []**uint64{&c.BlockNumber, &c.GasUsed, &c.TxNonce} {
		if *p != nil {
			v := **p
			*p = &v
		}
	}
	if e.CallSuccess != nil {
		v := *e.CallSuccess
		c.CallSuccess = &v
	}
	for _, p := range []**time.Time{&c.SubmittedAt, &c.ConfirmedAt} {
		if *p != nil {
			v := **p
			*p = &v
		}
	}
	return &c
}

func (s *sharedStore) failSessionLocked(ss *store.SigningSession, reason string, by *uuid.UUID, now time.Time) {
	ss.Status = store.SigningFailed
	ss.FailureReason = reason
	ss.FailedBy = by
	t := now
	ss.EndedAt = &t
}

// expireLocked fails an open session past its deadline.
func (s *sharedStore) expireLocked(ss *store.SigningSession, now time.Time) {
	if ss.Status.Open() && ss.Status != store.SigningCombining && !now.Before(ss.ExpiresAt) {
		s.failSessionLocked(ss, store.SigningFailExpired, nil, now)
	}
}

func (s *sharedStore) signedLocked(proposalID uuid.UUID) bool {
	for _, ss := range s.sessions {
		if ss.ProposalID == proposalID && ss.Status == store.SigningComplete {
			return true
		}
	}
	return false
}

func (s *sharedStore) PutAccountKey(_ context.Context, k *store.AccountKey, att store.AccountKeyAttestation) (*store.AccountKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := [2]uuid.UUID{k.AccountID, k.KeygenID}
	cur, ok := s.accountKeys[key]
	if !ok {
		c := cpAccountKey(k)
		c.Attestations = []store.AccountKeyAttestation{{MemberID: att.MemberID, Signature: cpBytes(att.Signature), At: att.At}}
		s.accountKeys[key] = c
		return cpAccountKey(c), nil
	}
	if !bytes.Equal(cur.PublicKey, k.PublicKey) || cur.Address != k.Address {
		return nil, store.ErrMismatch
	}
	for _, a := range cur.Attestations {
		if a.MemberID == att.MemberID {
			return cpAccountKey(cur), nil
		}
	}
	cur.Attestations = append(cur.Attestations, store.AccountKeyAttestation{MemberID: att.MemberID, Signature: cpBytes(att.Signature), At: att.At})
	return cpAccountKey(cur), nil
}

func (s *sharedStore) GetAccountKey(_ context.Context, accountID, keygenID uuid.UUID) (*store.AccountKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k, ok := s.accountKeys[[2]uuid.UUID{accountID, keygenID}]
	if !ok {
		return nil, store.ErrNotFound
	}
	return cpAccountKey(k), nil
}

func (s *sharedStore) CreateSigningSession(_ context.Context, ss *store.SigningSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.proposals[ss.ProposalID]
	if !ok {
		return store.ErrNotFound
	}
	if _, ok := s.jobs[p.ID]; !ok || p.Status != store.ProposalApproved {
		return store.ErrProposalClosed
	}
	w := s.wallets[p.WalletID]
	if w.KeyStatus != store.KeyActive || w.KeyGenerationID == nil || *w.KeyGenerationID != ss.KeygenID ||
		w.MembershipVersion != ss.MembershipVersion || p.MembershipVersion != ss.MembershipVersion {
		return store.ErrStale
	}
	attempts := 0
	for _, other := range s.sessions {
		if other.ProposalID != p.ID {
			continue
		}
		attempts++
		s.expireLocked(other, ss.CreatedAt)
		switch {
		case other.Status == store.SigningComplete:
			return store.ErrAlreadySigned
		case other.Status.Open():
			return store.ErrConflict
		}
	}
	sid := hex.EncodeToString(ss.SID)
	if s.sids[sid] {
		return store.ErrConflict
	}
	s.sids[sid] = true
	c := cpSession(ss)
	c.Attempt = attempts + 1
	c.Status = store.SigningRound1
	s.sessions[c.ID] = c
	ss.Attempt, ss.Status = c.Attempt, c.Status
	return nil
}

func (s *sharedStore) GetSigningSession(_ context.Context, id uuid.UUID, now time.Time) (*store.SigningSession, []*store.SigningMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.sessions[id]
	if !ok {
		return nil, nil, store.ErrNotFound
	}
	s.expireLocked(ss, now)
	return cpSession(ss), cpMsgs(s.sessionMsgs[id]), nil
}

func (s *sharedStore) LatestSigningSession(_ context.Context, proposalID uuid.UUID, now time.Time) (*store.SigningSession, []*store.SigningMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest *store.SigningSession
	for _, ss := range s.sessions {
		if ss.ProposalID == proposalID && (latest == nil || ss.Attempt > latest.Attempt) {
			latest = ss
		}
	}
	if latest == nil {
		return nil, nil, store.ErrNotFound
	}
	s.expireLocked(latest, now)
	return cpSession(latest), cpMsgs(s.sessionMsgs[latest.ID]), nil
}

func (s *sharedStore) AddSigningMessage(_ context.Context, m *store.SigningMessage, now time.Time,
	check func(*store.SigningSession, []*store.SigningMessage) string) (*store.SigningSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.sessions[m.SessionID]
	if !ok {
		return nil, store.ErrNotFound
	}
	s.expireLocked(ss, now)
	if ss.Status.Round() != m.Round {
		return nil, store.ErrSigningClosed
	}
	pos := -1
	for i, idx := range ss.Act {
		if idx == m.PartyIndex && ss.SignerMemberIDs[i] == m.MemberID {
			pos = i
		}
	}
	if pos < 0 {
		return nil, store.ErrNotEligible
	}
	inRound := 0
	for _, x := range s.sessionMsgs[ss.ID] {
		if x.Round == m.Round {
			if x.PartyIndex == m.PartyIndex {
				return nil, store.ErrConflict
			}
			inRound++
		}
	}
	if check != nil {
		if reason := check(cpSession(ss), cpMsgs(s.sessionMsgs[ss.ID])); reason != "" {
			s.failSessionLocked(ss, reason, &m.MemberID, now)
			return nil, store.ErrSigningClosed
		}
	}
	c := *m
	c.Payload, c.DeviceSignature = cpBytes(m.Payload), cpBytes(m.DeviceSignature)
	s.sessionMsgs[ss.ID] = append(s.sessionMsgs[ss.ID], &c)
	if inRound+1 == len(ss.Act) {
		switch ss.Status {
		case store.SigningRound1:
			ss.Status = store.SigningRound2
		case store.SigningRound2:
			ss.Status = store.SigningRound3
		case store.SigningRound3:
			ss.Status = store.SigningCombining
		}
	}
	return cpSession(ss), nil
}

func (s *sharedStore) CompleteSigningSession(_ context.Context, id uuid.UUID, sig []byte, now time.Time) (*store.SigningSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.sessions[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	if ss.Status != store.SigningCombining {
		if ss.Status == store.SigningComplete {
			return nil, store.ErrAlreadySigned
		}
		return nil, store.ErrSigningClosed
	}
	ss.Status = store.SigningComplete
	ss.Signature = cpBytes(sig)
	t := now
	ss.EndedAt = &t
	s.executions[ss.ProposalID] = &store.Execution{
		ProposalID: ss.ProposalID, SessionID: ss.ID, WalletID: ss.WalletID, ChainID: ss.ChainID,
		AccountAddress: ss.AccountAddress, Status: store.ExecPending, Stage: store.ExecStageQueued, CreatedAt: now, UpdatedAt: now,
	}
	return cpSession(ss), nil
}

func (s *sharedStore) FailSigningSession(_ context.Context, id uuid.UUID, reason string, by *uuid.UUID, now time.Time) (*store.SigningSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.sessions[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	s.expireLocked(ss, now)
	if !ss.Status.Open() {
		return nil, store.ErrSigningClosed
	}
	s.failSessionLocked(ss, reason, by, now)
	return cpSession(ss), nil
}

func (s *sharedStore) GetExecution(_ context.Context, proposalID uuid.UUID) (*store.Execution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.executions[proposalID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return cpExecution(e), nil
}

func (s *sharedStore) ListExecutions(_ context.Context, statuses []store.ExecutionStatus) ([]*store.Execution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.Execution
	for _, e := range s.executions {
		for _, st := range statuses {
			if e.Status == st {
				out = append(out, cpExecution(e))
				break
			}
		}
	}
	return out, nil
}

func (s *sharedStore) UpdateExecution(_ context.Context, e *store.Execution, from store.ExecutionStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.executions[e.ProposalID]
	if !ok {
		return store.ErrNotFound
	}
	if cur.Status != from {
		return store.ErrConflict
	}
	s.executions[e.ProposalID] = cpExecution(e)
	return nil
}

func (s *sharedStore) RecordGasTransfer(_ context.Context, t *store.GasTransfer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := fmt.Sprintf("%d/%s", t.ChainID, t.TxHash)
	if old, ok := s.gasTransfers[key]; ok {
		if old.ProposalID == nil && t.ProposalID != nil {
			id := *t.ProposalID
			old.ProposalID = &id
		}
		if old.Kind == store.GasKindOther && t.Kind != store.GasKindOther {
			old.Kind = t.Kind
		}
		return nil
	}
	c := *t
	if t.ProposalID != nil {
		id := *t.ProposalID
		c.ProposalID = &id
	}
	s.gasTransfers[key] = &c
	return nil
}

func (s *sharedStore) ListGasTransfers(_ context.Context, chainID int64, address string, limit int) ([]*store.GasTransfer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.GasTransfer
	for _, t := range s.gasTransfers {
		if t.ChainID == chainID && strings.EqualFold(t.Address, address) {
			c := *t
			out = append(out, &c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BlockNumber != out[j].BlockNumber {
			return out[i].BlockNumber > out[j].BlockNumber
		}
		return out[i].TxHash < out[j].TxHash
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
