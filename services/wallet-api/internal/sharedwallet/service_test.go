package sharedwallet

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/platform/db"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/store/postgres"
)

// participant is an independent user with its own device key and session.
type participant struct {
	p    *auth.Principal
	key  *ecdsa.PrivateKey
	name string
}

type env struct {
	t     *testing.T
	st    store.Store
	svc   *Service
	clock time.Time
}

func newEnv(t *testing.T) *env {
	e := &env{t: t, st: testStore(t), clock: time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)}
	e.svc = NewService(e.st)
	e.svc.now = func() time.Time { return e.clock }
	return e
}

var ctx = context.Background()

// testStore is the in-memory store, or Postgres when TEST_DATABASE_URL is set
// (e.g. TEST_DATABASE_URL=postgres://… go test ./internal/sharedwallet), so the
// same scenarios exercise both implementations.
func testStore(t *testing.T) store.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		return memory.New()
	}
	if err := db.Migrate(url); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return postgres.New(pool)
}

func (e *env) newUser(name string) *participant {
	e.t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		e.t.Fatal(err)
	}
	der, err := auth.SPKIDER(&key.PublicKey)
	if err != nil {
		e.t.Fatal(err)
	}
	u := &store.User{ID: uuid.New(), Status: store.UserActive, CreatedAt: e.clock}
	d := &store.Device{ID: uuid.New(), UserID: u.ID, PublicKey: der, Platform: store.PlatformWeb, Label: name, LastSeenAt: e.clock, CreatedAt: e.clock}
	if err := e.st.Users().Create(ctx, u); err != nil {
		e.t.Fatal(err)
	}
	if err := e.st.Devices().Create(ctx, d); err != nil {
		e.t.Fatal(err)
	}
	return &participant{p: &auth.Principal{UserID: u.ID, DeviceID: d.ID, SessionID: uuid.New()}, key: key, name: name}
}

// wallet creates a shared wallet owned by users[0] and has every other user
// accept an invitation, as independent participants.
func (e *env) wallet(n int) (uuid.UUID, []*participant) {
	e.t.Helper()
	users := make([]*participant, n)
	for i := range users {
		users[i] = e.newUser(fmt.Sprintf("P%d", i+1))
	}
	w, err := e.svc.CreateWallet(ctx, users[0].p, "Team", "P1")
	if err != nil {
		e.t.Fatal(err)
	}
	for _, u := range users[1:] {
		_, code, err := e.svc.CreateInvitation(ctx, users[0].p, w.ID, u.name)
		if err != nil {
			e.t.Fatal(err)
		}
		if _, _, err := e.svc.AcceptInvitation(ctx, u.p, code, u.name); err != nil {
			e.t.Fatal(err)
		}
	}
	return w.ID, users
}

func (e *env) account(walletID uuid.UUID, u *participant, name string) *store.SharedAccount {
	e.t.Helper()
	a, err := e.svc.CreateAccount(ctx, u.p, walletID, name)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

func (e *env) propose(walletID uuid.UUID, u *participant, acct uuid.UUID) *store.Proposal {
	e.t.Helper()
	prop, err := e.svc.CreateProposal(ctx, u.p, walletID, ProposalInput{
		AccountID: acct, ChainID: 31337, To: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		ValueWei: "1000000000000000000", Nonce: 0, GasLimit: 21000, MaxFeePerGas: "2000000000", MaxPriorityFeePerGas: "1000000000",
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return prop
}

func sign(t *testing.T, key *ecdsa.PrivateKey, msg []byte) string {
	t.Helper()
	h := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, key, h[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(auth.EncodeP1363Signature(elliptic.P256(), r, s))
}

// signedVote builds a correctly signed vote the way the web client does.
func (e *env) signedVote(u *participant, prop *store.Proposal, d store.VoteDecision) VoteInput {
	e.t.Helper()
	n, err := e.svc.IssueVoteNonce(ctx, u.p, prop.ID)
	if err != nil {
		e.t.Fatalf("%s nonce: %v", u.name, err)
	}
	issued := e.clock.Unix()
	return VoteInput{
		Decision: d, Nonce: n.Nonce, IssuedAtUnix: issued, DigestHex: hex.EncodeToString(prop.Digest),
		Signature: sign(e.t, u.key, VoteMessage(d, prop, n.MemberID, n.Nonce, issued)),
	}
}

func (e *env) vote(u *participant, prop *store.Proposal, d store.VoteDecision) (*ProposalView, error) {
	e.t.Helper()
	return e.svc.CastVote(ctx, u.p, prop.ID, e.signedVote(u, prop, d))
}

func (e *env) ok(v *ProposalView, err error) *ProposalView {
	e.t.Helper()
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

// ---------------------------------------------------------------------------

func TestFiveParticipantScenario(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(5)
	view, err := e.svc.GetWallet(ctx, users[0].p, wid)
	if err != nil {
		t.Fatal(err)
	}
	if view.Active != 5 || view.Required != 3 {
		t.Fatalf("active=%d required=%d, want 5 and 3", view.Active, view.Required)
	}
	acct := e.account(wid, users[0], "Ops")
	prop := e.propose(wid, users[0], acct.ID)

	v := e.ok(e.vote(users[0], prop, store.VoteApprove))
	v = e.ok(e.vote(users[1], prop, store.VoteApprove))
	if v.Approvals != 2 || v.Proposal.Status != store.ProposalPending || v.SigningJob != nil {
		t.Fatalf("after 2 approvals: %d %s job=%v; signing must not start", v.Approvals, v.Proposal.Status, v.SigningJob)
	}
	v = e.ok(e.vote(users[2], prop, store.VoteApprove))
	if v.Approvals != 3 || v.Proposal.Status != store.ProposalApproved {
		t.Fatalf("after 3 approvals: %d %s", v.Approvals, v.Proposal.Status)
	}
	if v.SigningJob == nil || v.SigningJob.Status != store.SigningAwaitingKey || len(v.SigningJob.Signers) != 3 {
		t.Fatalf("signing job: %+v", v.SigningJob)
	}
	// The job names exactly T signers, the first three approvers.
	for i, u := range users[:3] {
		m, _ := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, u.p.UserID)
		if v.SigningJob.Signers[i] != m.ID {
			t.Errorf("signer %d is not %s", i, u.name)
		}
	}
	// Votes after the threshold are refused; the proposal no longer accepts votes.
	if _, err := e.svc.IssueVoteNonce(ctx, users[3].p, prop.ID); !errors.Is(err, ErrClosed) {
		t.Errorf("nonce after approval: %v", err)
	}
}

func TestInsufficientApprovalsOfTen(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(10)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)
	if prop.RequiredApprovals != 5 || prop.ParticipantCount != 10 {
		t.Fatalf("required %d of %d", prop.RequiredApprovals, prop.ParticipantCount)
	}
	for i := 0; i < 4; i++ {
		v := e.ok(e.vote(users[i], prop, store.VoteApprove))
		if v.Approvals != i+1 || v.Proposal.Status != store.ProposalPending || v.SigningJob != nil {
			t.Fatalf("%d approvals: status %s job %v", i+1, v.Proposal.Status, v.SigningJob)
		}
	}
	v := e.ok(e.vote(users[4], prop, store.VoteApprove))
	if v.Proposal.Status != store.ProposalApproved || v.SigningJob == nil {
		t.Fatalf("5/5: %s", v.Proposal.Status)
	}
}

func TestDuplicateAndReplayedVotes(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(5)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)

	in := e.signedVote(users[1], prop, store.VoteApprove)
	e.ok(e.svc.CastVote(ctx, users[1].p, prop.ID, in))
	// Exact replay of the same signed request: the nonce is spent.
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, in); !errors.Is(err, ErrNonceInvalid) {
		t.Errorf("replay: %v", err)
	}
	// Fresh nonce, second vote from the same participant.
	if _, err := e.vote(users[1], prop, store.VoteApprove); !errors.Is(err, ErrDuplicateVote) {
		t.Errorf("duplicate: %v", err)
	}
	if _, err := e.vote(users[1], prop, store.VoteReject); !errors.Is(err, ErrDuplicateVote) {
		t.Errorf("changing vote: %v", err)
	}
	// Another participant cannot use someone else's nonce.
	n, _ := e.svc.IssueVoteNonce(ctx, users[2].p, prop.ID)
	m3, _ := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, users[3].p.UserID)
	stolen := VoteInput{Decision: store.VoteApprove, Nonce: n.Nonce, IssuedAtUnix: e.clock.Unix(), DigestHex: hex.EncodeToString(prop.Digest),
		Signature: sign(t, users[3].key, VoteMessage(store.VoteApprove, prop, m3.ID, n.Nonce, e.clock.Unix()))}
	if _, err := e.svc.CastVote(ctx, users[3].p, prop.ID, stolen); !errors.Is(err, ErrNonceInvalid) {
		t.Errorf("nonce of another participant: %v", err)
	}
	// An approval signed for proposal A cannot be replayed on proposal B.
	propB := e.propose(wid, users[0], prop.AccountID)
	forA := e.signedVote(users[4], prop, store.VoteApprove)
	if _, err := e.svc.CastVote(ctx, users[4].p, propB.ID, forA); err == nil {
		t.Error("approval for A accepted on B")
	}
	v, _ := e.svc.GetProposal(ctx, users[0].p, prop.ID)
	if v.Approvals != 1 {
		t.Errorf("approvals %d, want 1", v.Approvals)
	}
}

func TestInvalidSignatureDigestAndDevice(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)

	bad := e.signedVote(users[1], prop, store.VoteApprove)
	bad.Signature = sign(t, users[2].key, VoteMessage(store.VoteApprove, prop, uuid.New(), bad.Nonce, bad.IssuedAtUnix))
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, bad); !errors.Is(err, ErrBadSignature) {
		t.Errorf("foreign key signature: %v", err)
	}
	// Signed "approve" but submitted as "reject": signature no longer matches.
	flipped := e.signedVote(users[1], prop, store.VoteApprove)
	flipped.Decision = store.VoteReject
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, flipped); !errors.Is(err, ErrBadSignature) {
		t.Errorf("flipped decision: %v", err)
	}
	wrongDigest := e.signedVote(users[1], prop, store.VoteApprove)
	wrongDigest.DigestHex = hex.EncodeToString(make([]byte, 32))
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, wrongDigest); !errors.Is(err, ErrDigestMismatch) {
		t.Errorf("different digest: %v", err)
	}
	stale := e.signedVote(users[1], prop, store.VoteApprove)
	stale.IssuedAtUnix = e.clock.Add(-time.Hour).Unix()
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, stale); !errors.Is(err, ErrInvalid) {
		t.Errorf("stale issuedAt: %v", err)
	}
	// Same user, different device (not the one bound at join).
	other := &auth.Principal{UserID: users[1].p.UserID, DeviceID: uuid.New(), SessionID: uuid.New()}
	if _, err := e.svc.CastVote(ctx, other, prop.ID, e.signedVote(users[1], prop, store.VoteApprove)); !errors.Is(err, ErrWrongDevice) {
		t.Errorf("wrong device: %v", err)
	}
	if v, _ := e.svc.GetProposal(ctx, users[0].p, prop.ID); v.Approvals != 0 {
		t.Errorf("an invalid vote was counted: %d", v.Approvals)
	}
}

func TestUnauthorizedAndRevokedParticipants(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(4)
	outsider := e.newUser("outsider")
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)

	if _, err := e.svc.GetProposal(ctx, outsider.p, prop.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("outsider read: %v", err)
	}
	if _, err := e.svc.IssueVoteNonce(ctx, outsider.p, prop.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("outsider nonce: %v", err)
	}
	if _, err := e.svc.GetWallet(ctx, outsider.p, wid); !errors.Is(err, ErrNotFound) {
		t.Errorf("outsider wallet: %v", err)
	}
	if _, _, err := e.svc.CreateInvitation(ctx, users[1].p, wid, "x"); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-owner invite: %v", err)
	}

	// Pre-issue a nonce, then revoke: the revoked participant can no longer vote.
	in := e.signedVote(users[3], prop, store.VoteApprove)
	m3, _ := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, users[3].p.UserID)
	if _, err := e.svc.RevokeParticipant(ctx, users[1].p, wid, m3.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("member revoking another: %v", err)
	}
	if _, err := e.svc.RevokeParticipant(ctx, users[0].p, wid, m3.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CastVote(ctx, users[3].p, prop.ID, in); !errors.Is(err, ErrNotFound) {
		t.Errorf("revoked vote: %v", err)
	}
	owner, _ := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, users[0].p.UserID)
	if _, err := e.svc.RevokeParticipant(ctx, users[0].p, wid, owner.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("owner revocation: %v", err)
	}
}

func TestExpiredProposal(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)
	in := e.signedVote(users[1], prop, store.VoteApprove)
	e.clock = prop.ExpiresAt.Add(time.Second)
	in.IssuedAtUnix = e.clock.Unix() // even with a fresh timestamp
	if _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, in); err == nil {
		t.Fatal("vote on expired proposal accepted")
	}
	v, _ := e.svc.GetProposal(ctx, users[0].p, prop.ID)
	if v.Proposal.Status != store.ProposalExpired || v.Approvals != 0 {
		t.Fatalf("status %s approvals %d", v.Proposal.Status, v.Approvals)
	}
	if _, err := e.svc.IssueVoteNonce(ctx, users[2].p, prop.ID); !errors.Is(err, ErrClosed) {
		t.Errorf("nonce for expired proposal: %v", err)
	}
}

func TestRejectionIsAVoteNotAVeto(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(10)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)
	for i := 0; i < 5; i++ {
		v := e.ok(e.vote(users[i], prop, store.VoteReject))
		if v.Proposal.Status != store.ProposalPending {
			t.Fatalf("%d rejections: %s; 5 others can still approve", i+1, v.Proposal.Status)
		}
	}
	v := e.ok(e.vote(users[5], prop, store.VoteReject))
	if v.Proposal.Status != store.ProposalRejected || v.SigningJob != nil {
		t.Fatalf("6 rejections: %s", v.Proposal.Status)
	}
	if _, err := e.svc.IssueVoteNonce(ctx, users[6].p, prop.ID); !errors.Is(err, ErrClosed) {
		t.Errorf("vote after rejection: %v", err)
	}
}

func TestMembershipChangesRecalculateOnlyNewProposals(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(10)
	acct := e.account(wid, users[0], "A")
	old := e.propose(wid, users[0], acct.ID)
	e.ok(e.vote(users[1], old, store.VoteApprove))

	newcomer := e.newUser("P11")
	_, code, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "P11")
	w, _, err := e.svc.AcceptInvitation(ctx, newcomer.p, code, "P11")
	if err != nil {
		t.Fatal(err)
	}
	if w.MembershipVersion != old.MembershipVersion+1 {
		t.Fatalf("membership version %d -> %d", old.MembershipVersion, w.MembershipVersion)
	}
	// The old proposal keeps its snapshot but can no longer be approved: its
	// participant set no longer matches the wallet (rekey required).
	ov, _ := e.svc.GetProposal(ctx, users[0].p, old.ID)
	if ov.Proposal.RequiredApprovals != 5 || ov.Proposal.ParticipantCount != 10 || ov.Proposal.Status != store.ProposalSuperseded {
		t.Fatalf("old proposal: %d of %d, %s", ov.Proposal.RequiredApprovals, ov.Proposal.ParticipantCount, ov.Proposal.Status)
	}
	if _, err := e.svc.IssueVoteNonce(ctx, users[2].p, old.ID); !errors.Is(err, ErrClosed) {
		t.Errorf("vote on superseded proposal: %v", err)
	}
	// The newcomer is not in the old snapshot.
	if containsUUID(ov.Proposal.EligibleMemberIDs, mustMember(t, e, wid, newcomer).ID) {
		t.Error("newcomer leaked into old snapshot")
	}
	n11 := e.propose(wid, users[0], acct.ID)
	if n11.RequiredApprovals != 6 || n11.ParticipantCount != 11 {
		t.Fatalf("11 participants: %d of %d", n11.RequiredApprovals, n11.ParticipantCount)
	}
	// Revocation back to 10 → 5; then 12 → 6.
	if _, err := e.svc.RevokeParticipant(ctx, users[0].p, wid, mustMember(t, e, wid, newcomer).ID); err != nil {
		t.Fatal(err)
	}
	if p := e.propose(wid, users[0], acct.ID); p.RequiredApprovals != 5 {
		t.Errorf("after revocation: %d", p.RequiredApprovals)
	}
	for _, name := range []string{"P12", "P13"} {
		u := e.newUser(name)
		_, code, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, name)
		if _, _, err := e.svc.AcceptInvitation(ctx, u.p, code, name); err != nil {
			t.Fatal(err)
		}
	}
	if p := e.propose(wid, users[0], acct.ID); p.RequiredApprovals != 6 || p.ParticipantCount != 12 {
		t.Errorf("12 participants: %d of %d", p.RequiredApprovals, p.ParticipantCount)
	}
	// No key generation exists, so nothing claims the cryptographic key changed.
	if wv, _ := e.svc.GetWallet(ctx, users[0].p, wid); wv.Wallet.KeyStatus != store.KeyNone {
		t.Errorf("key status %s", wv.Wallet.KeyStatus)
	}
}

func mustMember(t *testing.T, e *env, wid uuid.UUID, u *participant) *store.SharedMember {
	t.Helper()
	ms, _ := e.st.SharedWallets().ListMembers(ctx, wid)
	for _, m := range ms {
		if m.UserID == u.p.UserID {
			return m
		}
	}
	t.Fatalf("%s is not a member", u.name)
	return nil
}

func containsUUID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestConcurrentApprovalsReachThresholdOnce(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(10)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)
	inputs := make([]VoteInput, len(users))
	for i, u := range users {
		inputs[i] = e.signedVote(u, prop, store.VoteApprove)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, closed := 0, 0
	for i, u := range users {
		wg.Add(1)
		go func(u *participant, in VoteInput) {
			defer wg.Done()
			_, err := e.svc.CastVote(ctx, u.p, prop.ID, in)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrClosed):
				closed++
			default:
				t.Errorf("unexpected: %v", err)
			}
		}(u, inputs[i])
	}
	wg.Wait()
	if ok != 5 || closed != 5 {
		t.Fatalf("accepted %d, closed %d; want exactly 5 and 5", ok, closed)
	}
	v, _ := e.svc.GetProposal(ctx, users[0].p, prop.ID)
	if v.Approvals != 5 || v.Proposal.Status != store.ProposalApproved || v.SigningJob == nil || len(v.SigningJob.Signers) != 5 {
		t.Fatalf("approvals %d status %s job %+v", v.Approvals, v.Proposal.Status, v.SigningJob)
	}
}

func TestConcurrentDoubleVoteFromOneParticipant(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(5)
	prop := e.propose(wid, users[0], e.account(wid, users[0], "A").ID)
	a, b := e.signedVote(users[1], prop, store.VoteApprove), e.signedVote(users[1], prop, store.VoteApprove)
	errs := make(chan error, 2)
	for _, in := range []VoteInput{a, b} {
		go func(in VoteInput) { _, err := e.svc.CastVote(ctx, users[1].p, prop.ID, in); errs <- err }(in)
	}
	e1, e2 := <-errs, <-errs
	if (e1 == nil) == (e2 == nil) {
		t.Fatalf("want exactly one success: %v / %v", e1, e2)
	}
	if !errors.Is(e1, ErrDuplicateVote) && !errors.Is(e2, ErrDuplicateVote) {
		t.Errorf("loser error: %v / %v", e1, e2)
	}
}

func TestAccountsAreSeparateFromParticipants(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	before, _ := e.svc.GetWallet(ctx, users[0].p, wid)
	a0 := e.account(wid, users[0], "Treasury")
	a1 := e.account(wid, users[1], "Payroll")
	after, _ := e.svc.GetWallet(ctx, users[0].p, wid)
	if a0.DerivationIndex != 0 || a1.DerivationIndex != 1 {
		t.Fatalf("derivation indexes %d, %d", a0.DerivationIndex, a1.DerivationIndex)
	}
	if after.Active != before.Active || after.Wallet.MembershipVersion != before.Wallet.MembershipVersion {
		t.Fatal("creating accounts changed membership")
	}
	prop := e.propose(wid, users[2], a1.ID)
	if prop.AccountID != a1.ID || prop.DerivationIndex != 1 {
		t.Fatalf("proposal sender %s/%d", prop.AccountID, prop.DerivationIndex)
	}
	// An account of another wallet cannot be used as sender.
	wid2, others := e.wallet(1)
	foreign := e.account(wid2, others[0], "X")
	if _, err := e.svc.CreateProposal(ctx, users[0].p, wid, ProposalInput{AccountID: foreign.ID, ChainID: 1, To: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		ValueWei: "1", GasLimit: 21000, MaxFeePerGas: "1", MaxPriorityFeePerGas: "1"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("foreign account: %v", err)
	}
}

func TestInvitationLifecycle(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(1)
	bob, carol := e.newUser("bob"), e.newUser("carol")

	_, code, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "bob")
	if prev, err := e.svc.PreviewInvitation(ctx, code); err != nil || prev.WalletID != wid || prev.Active != 1 {
		t.Fatalf("preview: %+v %v", prev, err)
	}
	if _, _, err := e.svc.AcceptInvitation(ctx, bob.p, code, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.AcceptInvitation(ctx, carol.p, code, "carol"); !errors.Is(err, ErrInvitationInvalid) {
		t.Errorf("reused code: %v", err)
	}
	_, code2, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "bob again")
	if _, _, err := e.svc.AcceptInvitation(ctx, bob.p, code2, "bob"); !errors.Is(err, ErrAlreadyMember) {
		t.Errorf("duplicate membership: %v", err)
	}
	_, code3, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "carol")
	if err := e.svc.RejectInvitation(ctx, carol.p, code3); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.AcceptInvitation(ctx, carol.p, code3, "carol"); !errors.Is(err, ErrInvitationInvalid) {
		t.Errorf("accept after reject: %v", err)
	}
	_, code4, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "late")
	e.clock = e.clock.Add(invitationTTL + time.Second)
	if _, _, err := e.svc.AcceptInvitation(ctx, carol.p, code4, "carol"); !errors.Is(err, ErrInvitationInvalid) {
		t.Errorf("expired invitation: %v", err)
	}
	if _, _, err := e.svc.AcceptInvitation(ctx, carol.p, "not-a-code", "carol"); !errors.Is(err, ErrInvitationInvalid) {
		t.Errorf("unknown code: %v", err)
	}
}

func TestParticipantCapMatchesQdLimit(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(MaxMembers)
	extra := e.newUser("P65")
	_, code, err := e.svc.CreateInvitation(ctx, users[0].p, wid, "P65")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.AcceptInvitation(ctx, extra.p, code, "P65"); !errors.Is(err, ErrLimit) {
		t.Errorf("65th participant: %v", err)
	}
	if p := e.propose(wid, users[0], e.account(wid, users[0], "A").ID); p.RequiredApprovals != 32 {
		t.Errorf("64 participants: required %d", p.RequiredApprovals)
	}
}

func TestProposalValidation(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(2)
	acct := e.account(wid, users[0], "A")
	base := ProposalInput{AccountID: acct.ID, ChainID: 1, To: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		ValueWei: "1", GasLimit: 21000, MaxFeePerGas: "1", MaxPriorityFeePerGas: "1"}
	cases := map[string]func(*ProposalInput){
		"bad to":         func(in *ProposalInput) { in.To = "0x123" },
		"negative value": func(in *ProposalInput) { in.ValueWei = "-1" },
		"leading zero":   func(in *ProposalInput) { in.ValueWei = "01" },
		"over uint256": func(in *ProposalInput) {
			in.ValueWei = "115792089237316195423570985008687907853269984665640564039457584007913129639936"
		},
		"odd data":   func(in *ProposalInput) { in.Data = "0xabc" },
		"zero gas":   func(in *ProposalInput) { in.GasLimit = 0 },
		"zero chain": func(in *ProposalInput) { in.ChainID = 0 },
		"short ttl":  func(in *ProposalInput) { in.TTL = time.Minute },
	}
	for name, mutate := range cases {
		in := base
		mutate(&in)
		if _, err := e.svc.CreateProposal(ctx, users[0].p, wid, in); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Fixed vector shared with the web client's digest implementation.
func TestProposalDigestVector(t *testing.T) {
	p := &store.Proposal{
		ID: uuid.MustParse("01900000-0000-7000-8000-000000000001"), WalletID: uuid.MustParse("01900000-0000-7000-8000-000000000002"),
		AccountID: uuid.MustParse("01900000-0000-7000-8000-000000000003"), DerivationIndex: 1,
		InitiatorMemberID: uuid.MustParse("01900000-0000-7000-8000-000000000004"), ChainID: 31337,
		To: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", ValueWei: "1000000000000000000", Data: "0x",
		Nonce: 0, GasLimit: 21000, MaxFeePerGas: "2000000000", MaxPriorityFeePerGas: "1000000000",
		PolicyVersion: 1, PolicyNumerator: 1, PolicyDenominator: 2, PolicyRounding: "ceil",
		MembershipVersion: 5, ParticipantCount: 5, RequiredApprovals: 3,
		EligibleMemberIDs: []uuid.UUID{uuid.MustParse("01900000-0000-7000-8000-000000000005"), uuid.MustParse("01900000-0000-7000-8000-000000000004")},
		ExpiresAt:         time.Unix(1794657600, 0),
	}
	got := hex.EncodeToString(ProposalDigest(p))
	t.Logf("canonical: %s", ProposalCanonicalString(p))
	t.Logf("digest: %s", got)
	if got != proposalDigestVector {
		t.Fatalf("digest %s, want %s", got, proposalDigestVector)
	}
}
