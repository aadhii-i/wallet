package memory

import (
	"bytes"
	"context"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// sharedStore serializes every shared-wallet operation behind one mutex, so
// vote counting and status transitions are atomic (the postgres store uses a
// transaction with row locks for the same guarantee).
type sharedStore struct {
	mu          sync.Mutex
	wallets     map[uuid.UUID]*store.SharedWallet
	members     map[uuid.UUID]*store.SharedMember
	invitations map[uuid.UUID]*store.SharedInvitation
	accounts    map[uuid.UUID]*store.SharedAccount
	proposals   map[uuid.UUID]*store.Proposal
	votes       map[uuid.UUID][]*store.Vote // by proposal
	nonces      map[string]*store.VoteNonce
	jobs        map[uuid.UUID]*store.SigningJob // by proposal
	keygens     map[uuid.UUID]*store.KeyGeneration
	keygenParts map[uuid.UUID][]*store.KeygenParticipant // by keygen, ordered by party index
	accountKeys map[[2]uuid.UUID]*store.AccountKey       // by (account, keygen)
	sessions    map[uuid.UUID]*store.SigningSession
	sessionMsgs map[uuid.UUID][]*store.SigningMessage
	sids        map[string]bool
	executions  map[uuid.UUID]*store.Execution // by proposal
	// gasTransfers by "chainID/txHash"
	gasTransfers map[string]*store.GasTransfer
}

func newSharedStore() *sharedStore {
	return &sharedStore{
		wallets:      map[uuid.UUID]*store.SharedWallet{},
		members:      map[uuid.UUID]*store.SharedMember{},
		invitations:  map[uuid.UUID]*store.SharedInvitation{},
		accounts:     map[uuid.UUID]*store.SharedAccount{},
		proposals:    map[uuid.UUID]*store.Proposal{},
		votes:        map[uuid.UUID][]*store.Vote{},
		nonces:       map[string]*store.VoteNonce{},
		jobs:         map[uuid.UUID]*store.SigningJob{},
		keygens:      map[uuid.UUID]*store.KeyGeneration{},
		keygenParts:  map[uuid.UUID][]*store.KeygenParticipant{},
		accountKeys:  map[[2]uuid.UUID]*store.AccountKey{},
		sessions:     map[uuid.UUID]*store.SigningSession{},
		sessionMsgs:  map[uuid.UUID][]*store.SigningMessage{},
		sids:         map[string]bool{},
		executions:   map[uuid.UUID]*store.Execution{},
		gasTransfers: map[string]*store.GasTransfer{},
	}
}

func cp[T any](v *T) *T { c := *v; return &c }

func cpWallet(w *store.SharedWallet) *store.SharedWallet {
	c := *w
	c.KeyFingerprint = append([]byte(nil), w.KeyFingerprint...)
	if w.KeyGenerationID != nil {
		id := *w.KeyGenerationID
		c.KeyGenerationID = &id
	}
	return &c
}

func cpProposal(p *store.Proposal) *store.Proposal {
	c := *p
	c.EligibleMemberIDs = append([]uuid.UUID(nil), p.EligibleMemberIDs...)
	c.Digest = append([]byte(nil), p.Digest...)
	return &c
}

func (s *sharedStore) CreateWallet(_ context.Context, w *store.SharedWallet, owner *store.SharedMember) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.wallets[w.ID]; ok {
		return store.ErrConflict
	}
	s.wallets[w.ID] = cpWallet(w)
	s.members[owner.ID] = cp(owner)
	return nil
}

func (s *sharedStore) GetWallet(_ context.Context, id uuid.UUID) (*store.SharedWallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.wallets[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return cpWallet(w), nil
}

// LockNativeCustody shares the membership mutex; enrollment cannot race a roster change.
func (s *sharedStore) LockNativeCustody(_ context.Context, walletID uuid.UUID, version int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.wallets[walletID]
	if !ok {
		return store.ErrNotFound
	}
	if w.MembershipVersion != version {
		return store.ErrStale
	}
	w.NativeCustodyLocked = true
	return nil
}

func (s *sharedStore) ListWalletsForUser(_ context.Context, userID uuid.UUID) ([]*store.SharedWallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.SharedWallet
	for _, m := range s.members {
		if m.UserID == userID && m.Status == store.MemberActive {
			out = append(out, cpWallet(s.wallets[m.WalletID]))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *sharedStore) ListMembers(_ context.Context, walletID uuid.UUID) ([]*store.SharedMember, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.SharedMember
	for _, m := range s.members {
		if m.WalletID == walletID {
			out = append(out, cp(m))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].JoinedAt.Before(out[j].JoinedAt) })
	return out, nil
}

func (s *sharedStore) activeMemberLocked(walletID, userID uuid.UUID) *store.SharedMember {
	for _, m := range s.members {
		if m.WalletID == walletID && m.UserID == userID && m.Status == store.MemberActive {
			return m
		}
	}
	return nil
}

func (s *sharedStore) GetActiveMemberByUser(_ context.Context, walletID, userID uuid.UUID) (*store.SharedMember, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m := s.activeMemberLocked(walletID, userID); m != nil {
		return cp(m), nil
	}
	return nil, store.ErrNotFound
}

// membershipChangedLocked applies the side effects shared by join and revoke.
func (s *sharedStore) membershipChangedLocked(w *store.SharedWallet, now time.Time) {
	w.MembershipVersion++
	if w.KeyStatus == store.KeyActive {
		w.KeyStatus = store.KeyRekeyRequired
	}
	// A ceremony snapshot for the old membership can never produce a usable key.
	for _, kg := range s.keygens {
		if kg.WalletID == w.ID && kg.Status.Open() {
			s.failKeygenLocked(kg, store.KeygenFailMembershipChanged, now)
		}
	}
	// An open signing session was set up for the old membership's key.
	for _, ss := range s.sessions {
		if ss.WalletID == w.ID && ss.Status.Open() {
			s.failSessionLocked(ss, store.SigningFailMembershipChanged, nil, now)
		}
	}
	for _, p := range s.proposals {
		if p.WalletID == w.ID && (p.Status == store.ProposalPending || p.Status == store.ProposalApproved) {
			// A proposal that already has a verified signature is not
			// superseded: its execution was fully authorised beforehand.
			if s.signedLocked(p.ID) {
				continue
			}
			p.Status = store.ProposalSuperseded
			t := now
			p.DecidedAt = &t
		}
	}
}

func (s *sharedStore) RevokeMember(_ context.Context, walletID, memberID, revokedBy uuid.UUID, now time.Time) (*store.SharedWallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.wallets[walletID]
	m, mok := s.members[memberID]
	if !ok || !mok || m.WalletID != walletID {
		return nil, store.ErrNotFound
	}
	if w.NativeCustodyLocked {
		return nil, store.ErrNativeMigrationRequired
	}
	if m.Status == store.MemberRevoked {
		return nil, store.ErrConflict
	}
	m.Status = store.MemberRevoked
	t := now
	m.RevokedAt = &t
	by := revokedBy
	m.RevokedBy = &by
	s.membershipChangedLocked(w, now)
	return cpWallet(w), nil
}

func (s *sharedStore) CreateInvitation(_ context.Context, inv *store.SharedInvitation, maxOpen int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if w, ok := s.wallets[inv.WalletID]; !ok {
		return store.ErrNotFound
	} else if w.NativeCustodyLocked {
		return store.ErrNativeMigrationRequired
	}
	open := 0
	for _, i := range s.invitations {
		if i.WalletID == inv.WalletID && i.Status == store.InvitationInvited && i.ExpiresAt.After(inv.CreatedAt) {
			open++
		}
		if bytes.Equal(i.CodeHash, inv.CodeHash) {
			return store.ErrConflict
		}
	}
	if open >= maxOpen {
		return store.ErrLimit
	}
	s.invitations[inv.ID] = cp(inv)
	return nil
}

func (s *sharedStore) ListInvitations(_ context.Context, walletID uuid.UUID) ([]*store.SharedInvitation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.SharedInvitation
	for _, i := range s.invitations {
		if i.WalletID == walletID {
			out = append(out, cp(i))
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].CreatedAt.Before(out[b].CreatedAt) })
	return out, nil
}

func (s *sharedStore) invitationByHashLocked(h []byte) *store.SharedInvitation {
	for _, i := range s.invitations {
		if bytes.Equal(i.CodeHash, h) {
			return i
		}
	}
	return nil
}

func (s *sharedStore) GetInvitationByCodeHash(_ context.Context, h []byte) (*store.SharedInvitation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.invitationByHashLocked(h); i != nil {
		return cp(i), nil
	}
	return nil, store.ErrNotFound
}

func (s *sharedStore) AcceptInvitation(_ context.Context, h []byte, member *store.SharedMember, maxMembers int, now time.Time) (*store.SharedWallet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.invitationByHashLocked(h)
	if inv == nil || inv.Status != store.InvitationInvited || !now.Before(inv.ExpiresAt) {
		return nil, store.ErrInvitationInvalid
	}
	w := s.wallets[inv.WalletID]
	if w.NativeCustodyLocked {
		return nil, store.ErrNativeMigrationRequired
	}
	for _, m := range s.members {
		if m.WalletID == w.ID && m.UserID == member.UserID && m.Status != store.MemberRevoked {
			return nil, store.ErrConflict
		}
	}
	active := 0
	for _, m := range s.members {
		if m.WalletID == w.ID && m.Status == store.MemberActive {
			active++
		}
	}
	if active >= maxMembers {
		return nil, store.ErrLimit
	}
	nm := cp(member)
	nm.WalletID = w.ID
	inviter := inv.InvitedBy
	nm.InvitedBy = &inviter
	s.members[nm.ID] = nm
	inv.Status = store.InvitationAccepted
	t := now
	inv.ResolvedAt = &t
	uid := member.UserID
	inv.ResolvedBy = &uid
	mid := nm.ID
	inv.MemberID = &mid
	s.membershipChangedLocked(w, now)
	return cpWallet(w), nil
}

func (s *sharedStore) RejectInvitation(_ context.Context, h []byte, userID uuid.UUID, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.invitationByHashLocked(h)
	if inv == nil || inv.Status != store.InvitationInvited || !now.Before(inv.ExpiresAt) {
		return store.ErrInvitationInvalid
	}
	inv.Status = store.InvitationRejected
	t := now
	inv.ResolvedAt = &t
	uid := userID
	inv.ResolvedBy = &uid
	return nil
}

func (s *sharedStore) RevokeInvitation(_ context.Context, walletID, invitationID uuid.UUID, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv, ok := s.invitations[invitationID]
	if !ok || inv.WalletID != walletID {
		return store.ErrNotFound
	}
	if inv.Status != store.InvitationInvited {
		return store.ErrInvitationInvalid
	}
	inv.Status = store.InvitationRevoked
	t := now
	inv.ResolvedAt = &t
	return nil
}

func (s *sharedStore) CreateAccount(_ context.Context, a *store.SharedAccount) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.accounts {
		if x.WalletID == a.WalletID && x.DerivationIndex == a.DerivationIndex {
			return store.ErrConflict
		}
	}
	s.accounts[a.ID] = cp(a)
	return nil
}

func (s *sharedStore) ListAccounts(_ context.Context, walletID uuid.UUID) ([]*store.SharedAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.SharedAccount
	for _, a := range s.accounts {
		if a.WalletID == walletID {
			out = append(out, cp(a))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DerivationIndex < out[j].DerivationIndex })
	return out, nil
}

func (s *sharedStore) GetAccount(_ context.Context, walletID, accountID uuid.UUID) (*store.SharedAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.accounts[accountID]
	if !ok || a.WalletID != walletID {
		return nil, store.ErrNotFound
	}
	return cp(a), nil
}

func (s *sharedStore) CreateProposal(_ context.Context, p *store.Proposal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.wallets[p.WalletID]
	if !ok {
		return store.ErrNotFound
	}
	if w.MembershipVersion != p.MembershipVersion {
		return store.ErrStale
	}
	if _, ok := s.proposals[p.ID]; ok {
		return store.ErrConflict
	}
	s.proposals[p.ID] = cpProposal(p)
	return nil
}

func (s *sharedStore) GetProposal(_ context.Context, id uuid.UUID) (*store.Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.proposals[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return cpProposal(p), nil
}

func (s *sharedStore) ListProposals(_ context.Context, walletID uuid.UUID) ([]*store.Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.Proposal
	for _, p := range s.proposals {
		if p.WalletID == walletID {
			out = append(out, cpProposal(p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *sharedStore) ExpireProposal(_ context.Context, id uuid.UUID, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.proposals[id]
	if !ok {
		return store.ErrNotFound
	}
	if p.Status == store.ProposalPending && !now.Before(p.ExpiresAt) {
		p.Status = store.ProposalExpired
		t := now
		p.DecidedAt = &t
	}
	return nil
}

func (s *sharedStore) CreateVoteNonce(_ context.Context, n *store.VoteNonce) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.nonces[n.Nonce]; ok {
		return store.ErrConflict
	}
	s.nonces[n.Nonce] = cp(n)
	return nil
}

func (s *sharedStore) CastVote(_ context.Context, v *store.Vote, now time.Time, decide store.DecideFunc) (*store.Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	n, ok := s.nonces[v.Nonce]
	if !ok || n.UsedAt != nil || !now.Before(n.ExpiresAt) || n.ProposalID != v.ProposalID || n.MemberID != v.MemberID {
		return nil, store.ErrNonceInvalid
	}
	// The nonce is spent even if the vote is then refused, so it can never be replayed.
	t := now
	n.UsedAt = &t

	p, ok := s.proposals[v.ProposalID]
	if !ok {
		return nil, store.ErrNotFound
	}
	if p.Status == store.ProposalPending && !now.Before(p.ExpiresAt) {
		p.Status = store.ProposalExpired
		p.DecidedAt = &t
	}
	if p.Status != store.ProposalPending {
		return nil, store.ErrProposalClosed
	}
	m, ok := s.members[v.MemberID]
	if !ok || m.WalletID != p.WalletID || m.Status != store.MemberActive || !containsID(p.EligibleMemberIDs, m.ID) {
		return nil, store.ErrNotEligible
	}
	for _, existing := range s.votes[p.ID] {
		if existing.MemberID == v.MemberID {
			return nil, store.ErrConflict
		}
	}

	next := append(append([]*store.Vote(nil), s.votes[p.ID]...), cp(v))
	approvals, rejections := 0, 0
	var approvers []uuid.UUID
	for _, x := range next {
		if x.Decision == store.VoteApprove {
			approvals++
			approvers = append(approvers, x.MemberID)
		} else {
			rejections++
		}
	}
	status, err := decide(cpProposal(p), approvals, rejections)
	if err != nil {
		return nil, err
	}
	s.votes[p.ID] = next
	if status != p.Status {
		p.Status = status
		p.DecidedAt = &t
	}
	if status == store.ProposalApproved {
		if _, exists := s.jobs[p.ID]; !exists {
			s.jobs[p.ID] = &store.SigningJob{
				ID:         uuid.New(),
				ProposalID: p.ID,
				Status:     store.SigningAwaitingKey,
				Signers:    append([]uuid.UUID(nil), approvers[:p.RequiredApprovals]...),
				CreatedAt:  now,
			}
		}
	}
	return cpProposal(p), nil
}

func containsID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func (s *sharedStore) ListVotes(_ context.Context, proposalID uuid.UUID) ([]*store.Vote, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*store.Vote, 0, len(s.votes[proposalID]))
	for _, v := range s.votes[proposalID] {
		out = append(out, cp(v))
	}
	return out, nil
}

func (s *sharedStore) GetSigningJob(_ context.Context, proposalID uuid.UUID) (*store.SigningJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.jobs[proposalID]
	if !ok {
		return nil, store.ErrNotFound
	}
	c := *j
	c.Signers = append([]uuid.UUID(nil), j.Signers...)
	return &c, nil
}

var _ store.SharedWallets = (*sharedStore)(nil)
