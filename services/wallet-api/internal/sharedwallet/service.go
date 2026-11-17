package sharedwallet

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/audit"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/authorization"
	"github.com/qdwallet/wallet-api/internal/store"
)

const (
	// MaxMembers is the QD key limit (qd-crypto MAX_PARTIES); a wallet whose
	// approvals could never be backed by a Threshold Raccoon key is refused.
	MaxMembers         = authorization.QdMaxParties
	maxOpenInvitations = 64
	invitationTTL      = 72 * time.Hour
	voteNonceTTL       = 2 * time.Minute
	voteClockSkew      = 5 * time.Minute
	minProposalTTL     = 5 * time.Minute
	maxProposalTTL     = 7 * 24 * time.Hour
	defaultProposalTTL = 24 * time.Hour
	maxDataBytes       = 16 * 1024
)

var (
	ErrNotFound          = errors.New("sharedwallet: not found")
	ErrForbidden         = errors.New("sharedwallet: not permitted")
	ErrInvalid           = errors.New("sharedwallet: invalid request")
	ErrAlreadyMember     = errors.New("sharedwallet: already a participant")
	ErrInvitationInvalid = errors.New("sharedwallet: invitation invalid or expired")
	ErrLimit             = errors.New("sharedwallet: limit reached")
	ErrStale             = errors.New("sharedwallet: membership changed; retry")
	ErrNonceInvalid      = errors.New("sharedwallet: vote nonce invalid")
	ErrBadSignature      = errors.New("sharedwallet: vote signature invalid")
	ErrDigestMismatch    = errors.New("sharedwallet: vote is for a different digest")
	ErrClosed            = errors.New("sharedwallet: proposal is not open for votes")
	ErrNotEligible       = errors.New("sharedwallet: participant is not eligible to vote")
	ErrDuplicateVote     = errors.New("sharedwallet: participant already voted")
	ErrWrongDevice       = errors.New("sharedwallet: vote must come from the participant's registered device")
)

type Service struct {
	store store.Store
	now   func() time.Time
}

func NewService(st store.Store) *Service {
	return &Service{store: st, now: func() time.Time { return time.Now().UTC() }}
}

func newID() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.New()
	}
	return id
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func codeHash(code string) []byte {
	h := sha256.Sum256([]byte("QDWallet-Invite|v1|" + code))
	return h[:]
}

func mapStoreErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, store.ErrStale):
		return ErrStale
	case errors.Is(err, store.ErrNonceInvalid):
		return ErrNonceInvalid
	case errors.Is(err, store.ErrProposalClosed):
		return ErrClosed
	case errors.Is(err, store.ErrNotEligible):
		return ErrNotEligible
	case errors.Is(err, store.ErrLimit):
		return ErrLimit
	case errors.Is(err, store.ErrInvitationInvalid):
		return ErrInvitationInvalid
	}
	return err
}

func (s *Service) record(ctx context.Context, actorUser uuid.UUID, action, subjectType, subjectID string, meta map[string]any) {
	_ = audit.Record(ctx, s.store.AuditLogs(), "user", actorUser.String(), action, subjectType, subjectID, meta)
}

func policyOf(w *store.SharedWallet) authorization.Policy {
	return authorization.Policy{
		Version:     w.PolicyVersion,
		Numerator:   w.PolicyNumerator,
		Denominator: w.PolicyDenominator,
		Rounding:    authorization.Rounding(w.PolicyRounding),
	}
}

// ---- wallets and membership --------------------------------------------------

// View is a participant's view of a wallet.
type View struct {
	Wallet      *store.SharedWallet
	Me          *store.SharedMember
	Members     []*store.SharedMember
	Active      int
	Required    int
	Accounts    []*store.SharedAccount
	Invitations []*store.SharedInvitation // owner only
	// KeyGen is the newest key-generation ceremony, if any.
	KeyGen      *store.KeyGeneration
	KeyGenParts []*store.KeygenParticipant
	// AccountKeys are the registered pk_j (and QdAccount addresses) under the active key.
	AccountKeys map[uuid.UUID]*store.AccountKey
}

func (s *Service) CreateWallet(ctx context.Context, p *auth.Principal, name, displayName string) (*store.SharedWallet, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 64 || len(displayName) > 64 {
		return nil, fmt.Errorf("%w: name must be 1-64 characters", ErrInvalid)
	}
	device, err := s.store.Devices().Get(ctx, p.UserID, p.DeviceID)
	if err != nil {
		return nil, ErrForbidden
	}
	now := s.now()
	pol := authorization.DefaultPolicy()
	w := &store.SharedWallet{
		ID: newID(), Name: name, CreatedBy: p.UserID,
		PolicyVersion: pol.Version, PolicyNumerator: pol.Numerator, PolicyDenominator: pol.Denominator, PolicyRounding: string(pol.Rounding),
		MembershipVersion: 1, KeyStatus: store.KeyNone, CreatedAt: now,
	}
	owner := &store.SharedMember{
		ID: newID(), WalletID: w.ID, UserID: p.UserID, DeviceID: device.ID, DevicePublicKey: device.PublicKey,
		DisplayName: strings.TrimSpace(displayName), Role: store.RoleOwner, Status: store.MemberActive, JoinedAt: now,
	}
	if err := s.store.SharedWallets().CreateWallet(ctx, w, owner); err != nil {
		return nil, err
	}
	s.record(ctx, p.UserID, "shared_wallet.create", "shared_wallet", w.ID.String(), map[string]any{"participant": owner.ID.String()})
	return w, nil
}

func (s *Service) ListWallets(ctx context.Context, p *auth.Principal) ([]*View, error) {
	ws, err := s.store.SharedWallets().ListWalletsForUser(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	out := make([]*View, 0, len(ws))
	for _, w := range ws {
		v, err := s.GetWallet(ctx, p, w.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// member returns the caller's active membership; anything else is ErrNotFound
// so non-members cannot even learn that a wallet exists.
func (s *Service) member(ctx context.Context, p *auth.Principal, walletID uuid.UUID) (*store.SharedWallet, *store.SharedMember, error) {
	m, err := s.store.SharedWallets().GetActiveMemberByUser(ctx, walletID, p.UserID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	w, err := s.store.SharedWallets().GetWallet(ctx, walletID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	return w, m, nil
}

func (s *Service) GetWallet(ctx context.Context, p *auth.Principal, walletID uuid.UUID) (*View, error) {
	w, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	members, err := s.store.SharedWallets().ListMembers(ctx, walletID)
	if err != nil {
		return nil, err
	}
	active := 0
	for _, m := range members {
		if m.Status == store.MemberActive {
			active++
		}
	}
	required, err := policyOf(w).RequiredApprovals(active)
	if err != nil {
		return nil, err
	}
	accounts, err := s.store.SharedWallets().ListAccounts(ctx, walletID)
	if err != nil {
		return nil, err
	}
	v := &View{Wallet: w, Me: me, Members: members, Active: active, Required: required, Accounts: accounts}
	v.AccountKeys = s.accountKeys(ctx, w, accounts)
	if v.KeyGen, v.KeyGenParts, err = s.latestKeygen(ctx, walletID); err != nil {
		return nil, err
	}
	if me.Role == store.RoleOwner {
		if v.Invitations, err = s.store.SharedWallets().ListInvitations(ctx, walletID); err != nil {
			return nil, err
		}
	}
	return v, nil
}

func (s *Service) CreateInvitation(ctx context.Context, p *auth.Principal, walletID uuid.UUID, label string) (*store.SharedInvitation, string, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, "", err
	}
	if me.Role != store.RoleOwner {
		return nil, "", ErrForbidden
	}
	if len(label) > 64 {
		return nil, "", fmt.Errorf("%w: label too long", ErrInvalid)
	}
	code := randomToken(32)
	now := s.now()
	inv := &store.SharedInvitation{
		ID: newID(), WalletID: walletID, CodeHash: codeHash(code), Label: strings.TrimSpace(label),
		InvitedBy: me.ID, Status: store.InvitationInvited, ExpiresAt: now.Add(invitationTTL), CreatedAt: now,
	}
	if err := s.store.SharedWallets().CreateInvitation(ctx, inv, maxOpenInvitations); err != nil {
		return nil, "", mapStoreErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.invitation.create", "shared_wallet", walletID.String(), map[string]any{"invitation": inv.ID.String()})
	return inv, code, nil
}

func (s *Service) RevokeInvitation(ctx context.Context, p *auth.Principal, walletID, invitationID uuid.UUID) error {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return err
	}
	if me.Role != store.RoleOwner {
		return ErrForbidden
	}
	if err := s.store.SharedWallets().RevokeInvitation(ctx, walletID, invitationID, s.now()); err != nil {
		return mapStoreErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.invitation.revoke", "shared_wallet", walletID.String(), map[string]any{"invitation": invitationID.String()})
	return nil
}

// InvitationPreview is what an invitee may see before accepting.
type InvitationPreview struct {
	WalletID   uuid.UUID
	WalletName string
	InvitedBy  string
	Active     int
	ExpiresAt  time.Time
}

func (s *Service) PreviewInvitation(ctx context.Context, code string) (*InvitationPreview, error) {
	inv, err := s.store.SharedWallets().GetInvitationByCodeHash(ctx, codeHash(code))
	if err != nil || inv.Status != store.InvitationInvited || !s.now().Before(inv.ExpiresAt) {
		return nil, ErrInvitationInvalid
	}
	w, err := s.store.SharedWallets().GetWallet(ctx, inv.WalletID)
	if err != nil {
		return nil, ErrInvitationInvalid
	}
	members, err := s.store.SharedWallets().ListMembers(ctx, inv.WalletID)
	if err != nil {
		return nil, err
	}
	prev := &InvitationPreview{WalletID: w.ID, WalletName: w.Name, ExpiresAt: inv.ExpiresAt}
	for _, m := range members {
		if m.Status == store.MemberActive {
			prev.Active++
		}
		if m.ID == inv.InvitedBy {
			prev.InvitedBy = m.DisplayName
		}
	}
	return prev, nil
}

func (s *Service) AcceptInvitation(ctx context.Context, p *auth.Principal, code, displayName string) (*store.SharedWallet, *store.SharedMember, error) {
	if len(displayName) > 64 {
		return nil, nil, fmt.Errorf("%w: display name too long", ErrInvalid)
	}
	device, err := s.store.Devices().Get(ctx, p.UserID, p.DeviceID)
	if err != nil || device.RevokedAt != nil {
		return nil, nil, ErrForbidden
	}
	now := s.now()
	m := &store.SharedMember{
		ID: newID(), UserID: p.UserID, DeviceID: device.ID, DevicePublicKey: device.PublicKey,
		DisplayName: strings.TrimSpace(displayName), Role: store.RoleMember, Status: store.MemberActive, JoinedAt: now,
	}
	w, err := s.store.SharedWallets().AcceptInvitation(ctx, codeHash(code), m, MaxMembers, now)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, nil, ErrAlreadyMember
		}
		return nil, nil, mapStoreErr(err)
	}
	m.WalletID = w.ID
	s.record(ctx, p.UserID, "shared_wallet.participant.join", "shared_wallet", w.ID.String(),
		map[string]any{"participant": m.ID.String(), "membershipVersion": w.MembershipVersion})
	return w, m, nil
}

func (s *Service) RejectInvitation(ctx context.Context, p *auth.Principal, code string) error {
	if err := s.store.SharedWallets().RejectInvitation(ctx, codeHash(code), p.UserID, s.now()); err != nil {
		return mapStoreErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.invitation.reject", "user", p.UserID.String(), nil)
	return nil
}

// RevokeParticipant: the owner may revoke any member; a member may revoke
// (leave) only themselves. The owner cannot be revoked, which would orphan
// membership management.
func (s *Service) RevokeParticipant(ctx context.Context, p *auth.Principal, walletID, participantID uuid.UUID) (*store.SharedWallet, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	members, err := s.store.SharedWallets().ListMembers(ctx, walletID)
	if err != nil {
		return nil, err
	}
	var target *store.SharedMember
	for _, m := range members {
		if m.ID == participantID {
			target = m
		}
	}
	if target == nil {
		return nil, ErrNotFound
	}
	if target.Role == store.RoleOwner || (me.Role != store.RoleOwner && me.ID != target.ID) {
		return nil, ErrForbidden
	}
	w, err := s.store.SharedWallets().RevokeMember(ctx, walletID, participantID, me.ID, s.now())
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrNotFound
		}
		return nil, mapStoreErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.participant.revoke", "shared_wallet", walletID.String(),
		map[string]any{"participant": participantID.String(), "membershipVersion": w.MembershipVersion})
	return w, nil
}

// ---- accounts ------------------------------------------------------------------

func (s *Service) CreateAccount(ctx context.Context, p *auth.Principal, walletID uuid.UUID, name string) (*store.SharedAccount, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 64 {
		return nil, fmt.Errorf("%w: name must be 1-64 characters", ErrInvalid)
	}
	for attempt := 0; attempt < 3; attempt++ {
		existing, err := s.store.SharedWallets().ListAccounts(ctx, walletID)
		if err != nil {
			return nil, err
		}
		next := int64(0)
		for _, a := range existing {
			if a.DerivationIndex >= next {
				next = a.DerivationIndex + 1
			}
		}
		a := &store.SharedAccount{ID: newID(), WalletID: walletID, Name: name, DerivationIndex: next, CreatedBy: me.ID, CreatedAt: s.now()}
		err = s.store.SharedWallets().CreateAccount(ctx, a)
		if errors.Is(err, store.ErrConflict) {
			continue // another participant took this index concurrently
		}
		if err != nil {
			return nil, err
		}
		s.record(ctx, p.UserID, "shared_wallet.account.create", "shared_wallet", walletID.String(),
			map[string]any{"account": a.ID.String(), "derivationIndex": a.DerivationIndex})
		return a, nil
	}
	return nil, ErrStale
}

// ---- proposals -----------------------------------------------------------------

type ProposalInput struct {
	AccountID            uuid.UUID
	ChainID              int64
	To                   string
	ValueWei             string
	Data                 string
	Nonce                uint64
	GasLimit             uint64
	MaxFeePerGas         string
	MaxPriorityFeePerGas string
	TTL                  time.Duration
}

var (
	addressRe  = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	hexDataRe  = regexp.MustCompile(`^0x([0-9a-fA-F]{2})*$`)
	maxUint256 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
)

func validUint256(s string) bool {
	if s == "" || len(s) > 78 || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, ok := new(big.Int).SetString(s, 10)
	return ok && n.Cmp(maxUint256) <= 0
}

func (in *ProposalInput) normalize() error {
	if in.ChainID <= 0 {
		return fmt.Errorf("%w: chainId must be positive", ErrInvalid)
	}
	if !addressRe.MatchString(in.To) {
		return fmt.Errorf("%w: recipient must be a 0x address", ErrInvalid)
	}
	in.To = strings.ToLower(in.To)
	if in.Data == "" {
		in.Data = "0x"
	}
	if !hexDataRe.MatchString(in.Data) || (len(in.Data)-2)/2 > maxDataBytes {
		return fmt.Errorf("%w: data must be 0x-prefixed hex up to %d bytes", ErrInvalid, maxDataBytes)
	}
	in.Data = strings.ToLower(in.Data)
	for _, v := range []string{in.ValueWei, in.MaxFeePerGas, in.MaxPriorityFeePerGas} {
		if !validUint256(v) {
			return fmt.Errorf("%w: amounts must be canonical decimal uint256", ErrInvalid)
		}
	}
	if in.GasLimit == 0 || in.GasLimit > 30_000_000 {
		return fmt.Errorf("%w: gasLimit out of range", ErrInvalid)
	}
	if in.TTL == 0 {
		in.TTL = defaultProposalTTL
	}
	if in.TTL < minProposalTTL || in.TTL > maxProposalTTL {
		return fmt.Errorf("%w: ttl must be between 5 minutes and 7 days", ErrInvalid)
	}
	return nil
}

func (s *Service) CreateProposal(ctx context.Context, p *auth.Principal, walletID uuid.UUID, in ProposalInput) (*store.Proposal, error) {
	if err := in.normalize(); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		w, me, err := s.member(ctx, p, walletID)
		if err != nil {
			return nil, err
		}
		acct, err := s.store.SharedWallets().GetAccount(ctx, walletID, in.AccountID)
		if err != nil {
			return nil, fmt.Errorf("%w: unknown sender account", ErrInvalid)
		}
		members, err := s.store.SharedWallets().ListMembers(ctx, walletID)
		if err != nil {
			return nil, err
		}
		var eligible []uuid.UUID
		for _, m := range members {
			if m.Status == store.MemberActive {
				eligible = append(eligible, m.ID)
			}
		}
		sort.Slice(eligible, func(i, j int) bool { return eligible[i].String() < eligible[j].String() })
		snap, err := authorization.NewSnapshot(policyOf(w), w.MembershipVersion, len(eligible))
		if err != nil {
			return nil, err
		}
		if err := snap.QdCompatibility(); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		now := s.now()
		prop := &store.Proposal{
			ID: newID(), WalletID: walletID, AccountID: acct.ID, DerivationIndex: acct.DerivationIndex,
			InitiatorMemberID: me.ID, ChainID: in.ChainID, To: in.To, ValueWei: in.ValueWei, Data: in.Data,
			Nonce: in.Nonce, GasLimit: in.GasLimit, MaxFeePerGas: in.MaxFeePerGas, MaxPriorityFeePerGas: in.MaxPriorityFeePerGas,
			PolicyVersion: snap.Policy.Version, PolicyNumerator: snap.Policy.Numerator, PolicyDenominator: snap.Policy.Denominator,
			PolicyRounding: string(snap.Policy.Rounding), MembershipVersion: snap.MembershipVersion,
			ParticipantCount: snap.ParticipantCount, RequiredApprovals: snap.RequiredApprovals,
			EligibleMemberIDs: eligible, Status: store.ProposalPending,
			// Second precision: the canonical string carries Unix seconds.
			ExpiresAt: now.Add(in.TTL).Truncate(time.Second), CreatedAt: now,
		}
		prop.Digest = ProposalDigest(prop)
		err = s.store.SharedWallets().CreateProposal(ctx, prop)
		if errors.Is(err, store.ErrStale) {
			continue // membership changed between snapshot and insert; take a fresh snapshot
		}
		if err != nil {
			return nil, err
		}
		s.record(ctx, p.UserID, "shared_wallet.proposal.create", "proposal", prop.ID.String(), map[string]any{
			"wallet": walletID.String(), "digest": hex.EncodeToString(prop.Digest),
			"required": prop.RequiredApprovals, "participants": prop.ParticipantCount,
		})
		return prop, nil
	}
	return nil, ErrStale
}

// ProposalView bundles a proposal with its tallies, as visible to a participant.
type ProposalView struct {
	Proposal   *store.Proposal
	Votes      []*store.Vote
	Approvals  int
	Rejections int
	MyVote     *store.Vote
	SigningJob *store.SigningJob
	// KeyReady: the wallet has an initialized Raccoon key generated for exactly
	// this proposal's membership snapshot. SignerIndexes are the signers'
	// party indices in that key (the future signing session's active set).
	KeyReady      bool
	SignerIndexes []int
	// AccountKey is the sender account's registered pk_j under the active key.
	AccountKey *store.AccountKey
	// Session is the latest signing session; Execution the on-chain submission.
	Session   *store.SigningSession
	Messages  []*store.SigningMessage
	Execution *store.Execution
}

func (s *Service) proposalForMember(ctx context.Context, p *auth.Principal, proposalID uuid.UUID) (*store.Proposal, *store.SharedMember, error) {
	prop, err := s.store.SharedWallets().GetProposal(ctx, proposalID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	_, me, err := s.member(ctx, p, prop.WalletID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	if prop.Status == store.ProposalPending && !s.now().Before(prop.ExpiresAt) {
		if err := s.store.SharedWallets().ExpireProposal(ctx, prop.ID, s.now()); err != nil {
			return nil, nil, err
		}
		if prop, err = s.store.SharedWallets().GetProposal(ctx, proposalID); err != nil {
			return nil, nil, err
		}
	}
	return prop, me, nil
}

func (s *Service) view(ctx context.Context, prop *store.Proposal, me *store.SharedMember) (*ProposalView, error) {
	votes, err := s.store.SharedWallets().ListVotes(ctx, prop.ID)
	if err != nil {
		return nil, err
	}
	v := &ProposalView{Proposal: prop, Votes: votes}
	for _, x := range votes {
		if x.Decision == store.VoteApprove {
			v.Approvals++
		} else {
			v.Rejections++
		}
		if x.MemberID == me.ID {
			v.MyVote = x
		}
	}
	job, err := s.store.SharedWallets().GetSigningJob(ctx, prop.ID)
	if err == nil {
		v.SigningJob = job
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if v.SigningJob != nil {
		if err := s.attachKey(ctx, v); err != nil {
			return nil, err
		}
		if err := s.attachSigning(ctx, v); err != nil {
			return nil, err
		}
	}
	if v.AccountKey == nil {
		// The sender's smart-account address, whenever its key is registered.
		sw := s.store.SharedWallets()
		if w, err := sw.GetWallet(ctx, prop.WalletID); err == nil && w.KeyGenerationID != nil && w.KeyStatus == store.KeyActive {
			if k, err := sw.GetAccountKey(ctx, prop.AccountID, *w.KeyGenerationID); err == nil {
				v.AccountKey = k
			}
		}
	}
	return v, nil
}

// attachSigning adds the account key, latest signing session and execution.
func (s *Service) attachSigning(ctx context.Context, v *ProposalView) error {
	sw := s.store.SharedWallets()
	if w, err := sw.GetWallet(ctx, v.Proposal.WalletID); err == nil && w.KeyGenerationID != nil && w.KeyStatus == store.KeyActive {
		if k, err := sw.GetAccountKey(ctx, v.Proposal.AccountID, *w.KeyGenerationID); err == nil {
			v.AccountKey = k
		}
	}
	ss, msgs, err := sw.LatestSigningSession(ctx, v.Proposal.ID, s.now())
	switch {
	case err == nil:
		if ss.Status == store.SigningCombining {
			if done, cerr := s.combine(ctx, ss, msgs, v.Proposal); cerr == nil && done != nil {
				ss = done
			}
		}
		v.Session, v.Messages = ss, msgs
		if v.AccountKey == nil || v.AccountKey.KeygenID != ss.KeygenID {
			if k, err := sw.GetAccountKey(ctx, v.Proposal.AccountID, ss.KeygenID); err == nil {
				v.AccountKey = k
			}
		}
	case !errors.Is(err, store.ErrNotFound):
		return err
	}
	if e, err := sw.GetExecution(ctx, v.Proposal.ID); err == nil {
		v.Execution = e
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return nil
}

// Lifecycle is the single honest status of a proposal, from approval to chain.
func (v *ProposalView) Lifecycle() string {
	switch v.Proposal.Status {
	case store.ProposalPending:
		return "awaiting_approvals"
	case store.ProposalRejected, store.ProposalExpired, store.ProposalSuperseded:
		if v.Execution == nil {
			return string(v.Proposal.Status)
		}
	}
	if v.Execution != nil {
		switch v.Execution.Status {
		case store.ExecPending, store.ExecSubmitting:
			// What the relayer is doing or waiting for (see store.ExecStage*).
			switch st := v.Execution.Stage; st {
			case "", store.ExecStageQueued:
				return "signature_verified"
			case store.ExecStageCheckingRelayer, store.ExecStageRelayerUnavailable, store.ExecStageAccountFunds,
				store.ExecStageRelayerFunds, store.ExecStageSettingUpVerifier, store.ExecStagePreparingAccount,
				store.ExecStageWaitingNonce:
				return st
			default:
				return "submitting"
			}
		case store.ExecSubmitted:
			return "submitted"
		case store.ExecConfirmed:
			return "confirmed"
		case store.ExecFailed:
			if v.Execution.Stage == store.ExecStageExpired {
				return "expired"
			}
			return "execution_failed"
		}
	}
	if v.SigningJob == nil {
		return "threshold_reached"
	}
	if v.Session != nil {
		switch v.Session.Status {
		case store.SigningFailed:
			return "signing_failed"
		case store.SigningRound1:
			if len(v.Messages) == 0 {
				return "awaiting_signers"
			}
			return "signing"
		case store.SigningComplete:
			return "signature_verified"
		default:
			return "signing"
		}
	}
	if !v.KeyReady {
		return "awaiting_key_generation"
	}
	if v.AccountKey == nil {
		return "awaiting_account_key"
	}
	return "awaiting_signers"
}

// attachKey marks a signing job as ready for a signing session only when a
// completed key generation matches the proposal's membership snapshot.
func (s *Service) attachKey(ctx context.Context, v *ProposalView) error {
	w, err := s.store.SharedWallets().GetWallet(ctx, v.Proposal.WalletID)
	if err != nil {
		return err
	}
	if w.KeyStatus != store.KeyActive || w.KeyGenerationID == nil {
		return nil
	}
	kg, parts, err := s.store.SharedWallets().GetKeyGeneration(ctx, *w.KeyGenerationID)
	if err != nil {
		return err
	}
	if kg.Status != store.KeygenComplete || kg.MembershipVersion != v.Proposal.MembershipVersion || kg.Threshold != v.Proposal.RequiredApprovals {
		return nil
	}
	index := map[uuid.UUID]int{}
	for _, p := range parts {
		index[p.MemberID] = p.PartyIndex
	}
	idx := make([]int, 0, len(v.SigningJob.Signers))
	for _, id := range v.SigningJob.Signers {
		i, ok := index[id]
		if !ok {
			return nil
		}
		idx = append(idx, i)
	}
	sort.Ints(idx)
	v.KeyReady, v.SignerIndexes = true, idx
	return nil
}

func (s *Service) GetProposal(ctx context.Context, p *auth.Principal, proposalID uuid.UUID) (*ProposalView, error) {
	prop, me, err := s.proposalForMember(ctx, p, proposalID)
	if err != nil {
		return nil, err
	}
	return s.view(ctx, prop, me)
}

func (s *Service) ListProposals(ctx context.Context, p *auth.Principal, walletID uuid.UUID) ([]*ProposalView, error) {
	_, me, err := s.member(ctx, p, walletID)
	if err != nil {
		return nil, err
	}
	props, err := s.store.SharedWallets().ListProposals(ctx, walletID)
	if err != nil {
		return nil, err
	}
	out := make([]*ProposalView, 0, len(props))
	now := s.now()
	for _, prop := range props {
		if prop.Status == store.ProposalPending && !now.Before(prop.ExpiresAt) {
			_ = s.store.SharedWallets().ExpireProposal(ctx, prop.ID, now)
			prop.Status = store.ProposalExpired
		}
		v, err := s.view(ctx, prop, me)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// ---- votes ---------------------------------------------------------------------

func (s *Service) IssueVoteNonce(ctx context.Context, p *auth.Principal, proposalID uuid.UUID) (*store.VoteNonce, error) {
	prop, me, err := s.proposalForMember(ctx, p, proposalID)
	if err != nil {
		return nil, err
	}
	if prop.Status != store.ProposalPending {
		return nil, ErrClosed
	}
	now := s.now()
	n := &store.VoteNonce{Nonce: randomToken(24), ProposalID: prop.ID, MemberID: me.ID, ExpiresAt: now.Add(voteNonceTTL), CreatedAt: now}
	if err := s.store.SharedWallets().CreateVoteNonce(ctx, n); err != nil {
		return nil, err
	}
	return n, nil
}

type VoteInput struct {
	Decision     store.VoteDecision
	Nonce        string
	IssuedAtUnix int64
	DigestHex    string // the digest the client computed and signed over
	Signature    string // base64url P1363 over VoteMessage
}

func (s *Service) CastVote(ctx context.Context, p *auth.Principal, proposalID uuid.UUID, in VoteInput) (*ProposalView, error) {
	if in.Decision != store.VoteApprove && in.Decision != store.VoteReject {
		return nil, fmt.Errorf("%w: decision must be approve or reject", ErrInvalid)
	}
	prop, me, err := s.proposalForMember(ctx, p, proposalID)
	if err != nil {
		return nil, err
	}
	// The vote must come from the device bound to this participant at join time.
	if me.DeviceID != p.DeviceID {
		return nil, ErrWrongDevice
	}
	claimed, err := hex.DecodeString(in.DigestHex)
	if err != nil || !bytes.Equal(claimed, prop.Digest) || !bytes.Equal(ProposalDigest(prop), prop.Digest) {
		return nil, ErrDigestMismatch
	}
	now := s.now()
	issued := time.Unix(in.IssuedAtUnix, 0)
	if issued.Before(now.Add(-voteClockSkew)) || issued.After(now.Add(voteClockSkew)) {
		return nil, fmt.Errorf("%w: issuedAt outside the allowed clock skew", ErrInvalid)
	}
	pub, err := auth.ParseSPKIPublicKeyB64URL(base64.RawURLEncoding.EncodeToString(me.DevicePublicKey))
	if err != nil {
		return nil, ErrBadSignature
	}
	msg := VoteMessage(in.Decision, prop, me.ID, in.Nonce, in.IssuedAtUnix)
	if err := auth.VerifyP1363SignatureB64URL(pub, msg, in.Signature); err != nil {
		return nil, ErrBadSignature
	}
	sig, _ := base64.RawURLEncoding.DecodeString(in.Signature)
	vote := &store.Vote{
		ID: newID(), ProposalID: prop.ID, MemberID: me.ID, Decision: in.Decision, Nonce: in.Nonce,
		IssuedAt: issued, Signature: sig, Digest: prop.Digest, CreatedAt: now,
	}
	decide := func(cur *store.Proposal, approvals, rejections int) (store.ProposalStatus, error) {
		snap := authorization.Snapshot{
			Policy: authorization.Policy{Version: cur.PolicyVersion, Numerator: cur.PolicyNumerator, Denominator: cur.PolicyDenominator,
				Rounding: authorization.Rounding(cur.PolicyRounding)},
			MembershipVersion: cur.MembershipVersion, ParticipantCount: cur.ParticipantCount, RequiredApprovals: cur.RequiredApprovals,
		}
		out, err := snap.Evaluate(approvals, rejections)
		if err != nil {
			return "", err
		}
		switch out {
		case authorization.OutcomeApproved:
			return store.ProposalApproved, nil
		case authorization.OutcomeRejected:
			return store.ProposalRejected, nil
		}
		return store.ProposalPending, nil
	}
	updated, err := s.store.SharedWallets().CastVote(ctx, vote, now, decide)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, ErrDuplicateVote
		}
		return nil, mapStoreErr(err)
	}
	s.record(ctx, p.UserID, "shared_wallet.vote", "proposal", prop.ID.String(), map[string]any{
		"participant": me.ID.String(), "decision": string(in.Decision), "status": string(updated.Status),
	})
	return s.view(ctx, updated, me)
}
