package sharedwallet

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/qdraccoon"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Coordinator state machine for networked signing. Round payloads here are
// well-formed but not produced from real key shares (those live only in
// participants' key workers): commitments are real SHA3 commitments to random
// openings, so sessions pass the round-2 opening check, and combining the
// random responses must then FAIL verification. The real-crypto path is in
// internal/qdraccoon (known-answer transcripts) and in the HTTP and browser
// end-to-end tests.

func randomPolyVec(t *testing.T, n int) qdraccoon.PolyVec {
	v := make(qdraccoon.PolyVec, n)
	for i := range v {
		for j := range v[i] {
			x, err := rand.Int(rand.Reader, big.NewInt(qdraccoon.Q))
			if err != nil {
				t.Fatal(err)
			}
			v[i][j] = x.Uint64()
		}
	}
	return v
}

// fakePublicKey is a canonical encoding (t < q_t) of a key nobody can sign for.
func fakePublicKey(t *testing.T) []byte {
	pk := rnd(t, qdraccoon.PublicKeyBytes)
	for i := 32; i < len(pk); i += 2 {
		v := (int(pk[i])<<8 | int(pk[i+1])) % qdraccoon.QT
		pk[i], pk[i+1] = byte(v>>8), byte(v)
	}
	return pk
}

func (e *env) registerAccountKey(u *participant, wid uuid.UUID, acct *store.SharedAccount, pk []byte) (*store.AccountKey, error) {
	v := must(e.svc.GetWallet(ctx, u.p, wid))
	dec, err := qdraccoon.DecodePublicKey(pk)
	if err != nil {
		e.t.Fatal(err)
	}
	h := qdraccoon.PublicKeyHash(dec)
	addr := lowerHex(h)
	return e.svc.RegisterAccountKey(ctx, u.p, wid, acct.ID, b64.EncodeToString(pk),
		sign(e.t, u.key, AccountKeyMessage(wid, acct.ID, acct.DerivationIndex, *v.Wallet.KeyGenerationID, h[:], addr)))
}

func lowerHex(h [32]byte) string {
	return strings.ToLower(qdaccount.AccountAddress(h).Hex())
}

// approvedProposal: n participants, an initialized key, a registered account
// key and a proposal approved by the first T participants (the signers).
func (e *env) approvedProposal(n int) (uuid.UUID, []*participant, *store.Proposal, []*participant) {
	e.t.Helper()
	wid, users := e.wallet(n)
	e.fullCeremony(wid, users)
	acct := e.account(wid, users[0], "Ops")
	if _, err := e.registerAccountKey(users[1], wid, acct, fakePublicKey(e.t)); err != nil {
		e.t.Fatal(err)
	}
	prop := e.propose(wid, users[0], acct.ID)
	signers := users[:prop.RequiredApprovals]
	for _, u := range signers {
		e.ok(e.vote(u, prop, store.VoteApprove))
	}
	return wid, users, prop, signers
}

type roundPayloads struct {
	w map[int]qdraccoon.PolyVec
}

func (e *env) payload(rp *roundPayloads, v *SigningView, round, idx int) []byte {
	ss := v.Session
	req := sessionRequest(ss)
	switch round {
	case 1:
		w := randomPolyVec(e.t, qdraccoon.K)
		rp.w[idx] = w
		cmt := qdraccoon.CommitmentHash(req, idx, w)
		return append(cmt[:], qdraccoon.EncodeQVec(randomPolyVec(e.t, qdraccoon.L))...)
	case 2:
		out := qdraccoon.EncodeQVec(rp.w[idx])
		for _, to := range ss.Act {
			if to != idx {
				out = append(append(out, byte(to)), rnd(e.t, 32)...)
			}
		}
		return out
	}
	return qdraccoon.EncodeQVec(randomPolyVec(e.t, qdraccoon.L))
}

func (e *env) submit(u *participant, v *SigningView, round int, payload []byte) (*SigningView, error) {
	idx := 0
	me := mustMember(e.t, e, v.Session.WalletID, u)
	for i, id := range v.Session.SignerMemberIDs {
		if id == me.ID {
			idx = v.Session.Act[i]
		}
	}
	tr := v.Transcript
	return e.svc.SubmitRound(ctx, u.p, v.Session.ID, round, b64.EncodeToString(payload), hex.EncodeToString(tr),
		sign(e.t, u.key, SignRoundMessage(v.Session, round, idx, me.ID, tr, payload)))
}

func partyOf(e *env, v *SigningView, u *participant) int {
	me := mustMember(e.t, e, v.Session.WalletID, u)
	for i, id := range v.Session.SignerMemberIDs {
		if id == me.ID {
			return v.Session.Act[i]
		}
	}
	return 0
}

func TestSigningSessionLifecycle(t *testing.T) {
	for _, n := range []int{3, 5} {
		e := newEnv(t)
		wid, users, prop, signers := e.approvedProposal(n)
		outsider := users[n-1] // not a signer (T = ⌈n/2⌉ < n)

		pv := must(e.svc.GetProposal(ctx, users[0].p, prop.ID))
		if pv.Lifecycle() != "awaiting_signers" || !pv.KeyReady || pv.AccountKey == nil {
			t.Fatalf("n=%d before start: %s", n, pv.Lifecycle())
		}
		wantErr(t, errOf(e.svc.StartSigning(ctx, outsider.p, prop.ID)), ErrNotSigner)
		v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
		if v.Session.Status != store.SigningRound1 || len(v.Session.SID) != 32 || len(v.Session.Act) != prop.RequiredApprovals {
			t.Fatalf("session: %+v", v.Session)
		}
		// Starting again (any signer) returns the same session, never a new sid.
		again := must(e.svc.StartSigning(ctx, signers[len(signers)-1].p, prop.ID))
		if again.Session.ID != v.Session.ID || string(again.Session.SID) != string(v.Session.SID) {
			t.Fatal("second start opened another session")
		}
		// The message is the QdAccount execution message for this proposal and account.
		if v.Session.AccountAddress != pv.AccountKey.Address || len(v.Session.Message) != 32 {
			t.Fatal("session not bound to the account")
		}

		rp := &roundPayloads{w: map[int]qdraccoon.PolyVec{}}
		// Guards in round 1.
		wantErr(t, errOf(e.submit(outsider, v, 1, e.payload(rp, v, 1, 1))), ErrNotSigner)
		wantErr(t, errOf(e.submit(signers[0], v, 2, e.payload(rp, v, 2, 1))), ErrSigningClosed)
		wantErr(t, errOf(e.submit(signers[0], v, 1, rnd(t, 10))), ErrBadRoundPayload)
		stale := *v
		stale.Transcript = rnd(t, 32)
		wantErr(t, errOf(e.submit(signers[0], &stale, 1, e.payload(rp, v, 1, partyOf(e, v, signers[0])))), ErrTranscriptMismatch)
		forged := e.payload(rp, v, 1, partyOf(e, v, signers[0]))
		wantErr(t, errOf(e.svc.SubmitRound(ctx, signers[0].p, v.Session.ID, 1, b64.EncodeToString(forged), hex.EncodeToString(v.Transcript),
			sign(t, signers[1].key, SignRoundMessage(v.Session, 1, partyOf(e, v, signers[0]), mustMember(t, e, wid, signers[0]).ID, v.Transcript, forged)))),
			ErrKeygenSignature)
		wrongDevice := *signers[0].p
		wrongDevice.DeviceID = uuid.New()
		wantErr(t, errOf(e.svc.SubmitRound(ctx, &wrongDevice, v.Session.ID, 1, "", "", "")), ErrWrongDevice)

		for round := 1; round <= 3; round++ {
			for k, u := range signers {
				cur := must(e.svc.GetSigning(ctx, u.p, v.Session.ID))
				if cur.Session.Status.Round() != round {
					t.Fatalf("n=%d expected round %d, got %s", n, round, cur.Session.Status)
				}
				res, err := e.submit(u, cur, round, e.payload(rp, cur, round, partyOf(e, cur, u)))
				if err != nil {
					t.Fatalf("n=%d round %d signer %d: %v", n, round, k, err)
				}
				if k == 0 {
					scratch := &roundPayloads{w: map[int]qdraccoon.PolyVec{partyOf(e, cur, u): rp.w[partyOf(e, cur, u)]}}
					wantErr(t, errOf(e.submit(u, cur, round, e.payload(scratch, cur, round, partyOf(e, cur, u)))), ErrDuplicateRoundMessage)
				}
				if k == 0 && round == 1 && len(signers) > 1 {
					if lc := must(e.svc.GetProposal(ctx, u.p, prop.ID)).Lifecycle(); lc != "signing" {
						t.Fatalf("lifecycle %s", lc)
					}
				}
				_ = res
			}
		}
		// Random responses: the coordinator's combine must refuse to output a signature.
		final := must(e.svc.GetSigning(ctx, signers[0].p, v.Session.ID))
		if final.Session.Status != store.SigningFailed || final.Session.FailureReason != store.SigningFailInvalidSignature || len(final.Session.Signature) != 0 {
			t.Fatalf("n=%d invalid transcript was not failed: %s %s", n, final.Session.Status, final.Session.FailureReason)
		}
		if final.Execution != nil {
			t.Fatal("an execution was created without a verified signature")
		}
		if lc := must(e.svc.GetProposal(ctx, users[0].p, prop.ID)).Lifecycle(); lc != "signing_failed" {
			t.Fatalf("lifecycle %s", lc)
		}
		// Safe retry: a new session with a new sid.
		retry := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
		if retry.Session.Attempt != 2 || string(retry.Session.SID) == string(v.Session.SID) || retry.Session.Status != store.SigningRound1 {
			t.Fatalf("retry: %+v", retry.Session)
		}
	}
}

func TestSigningInvalidCommitmentFailsSession(t *testing.T) {
	e := newEnv(t)
	_, _, prop, signers := e.approvedProposal(3)
	v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
	rp := &roundPayloads{w: map[int]qdraccoon.PolyVec{}}
	for _, u := range signers {
		cur := must(e.svc.GetSigning(ctx, u.p, v.Session.ID))
		must(e.submit(u, cur, 1, e.payload(rp, cur, 1, partyOf(e, cur, u))))
	}
	cur := must(e.svc.GetSigning(ctx, signers[0].p, v.Session.ID))
	idx := partyOf(e, cur, signers[0])
	rp.w[idx] = randomPolyVec(t, qdraccoon.K) // open something other than what was committed
	wantErr(t, errOf(e.submit(signers[0], cur, 2, e.payload(rp, cur, 2, idx))), ErrSigningClosed)
	after := must(e.svc.GetSigning(ctx, signers[1].p, v.Session.ID))
	if after.Session.Status != store.SigningFailed || after.Session.FailureReason != store.SigningFailInvalidCommitment {
		t.Fatalf("got %s %s", after.Session.Status, after.Session.FailureReason)
	}
	// Later messages are refused.
	wantErr(t, errOf(e.submit(signers[1], cur, 2, e.payload(rp, cur, 2, partyOf(e, cur, signers[1])))), ErrSigningClosed)
}

func TestSigningExpiryAbortAndAttemptLimit(t *testing.T) {
	e := newEnv(t)
	wid, users, prop, signers := e.approvedProposal(3)
	v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
	// Participant dropout: nobody answers; the session expires.
	e.clock = e.clock.Add(signingSessionTTL + time.Second)
	if got := must(e.svc.GetSigning(ctx, users[2].p, v.Session.ID)); got.Session.FailureReason != store.SigningFailExpired {
		t.Fatalf("expected expiry, got %s", got.Session.Status)
	}
	rp := &roundPayloads{w: map[int]qdraccoon.PolyVec{}}
	wantErr(t, errOf(e.submit(signers[0], v, 1, e.payload(rp, v, 1, partyOf(e, v, signers[0])))), ErrSigningClosed)

	// Abort: only a selected signer, with a device signature, for a known reason.
	for attempt := 2; attempt <= maxSigningAttempts; attempt++ {
		s := must(e.svc.StartSigning(ctx, signers[1].p, prop.ID))
		if s.Session.Attempt != attempt {
			t.Fatalf("attempt %d, want %d", s.Session.Attempt, attempt)
		}
		me := mustMember(t, e, wid, signers[1])
		wantErr(t, errOf(e.svc.AbortSigning(ctx, users[2].p, s.Session.ID, store.SigningFailCancelled, "")), ErrNotSigner)
		wantErr(t, errOf(e.svc.AbortSigning(ctx, signers[1].p, s.Session.ID, "because", "")), ErrInvalidAbortReason)
		wantErr(t, errOf(e.svc.AbortSigning(ctx, signers[1].p, s.Session.ID, store.SigningFailStateLost,
			sign(t, signers[0].key, SignAbortMessage(s.Session, me.ID, store.SigningFailStateLost)))), ErrKeygenSignature)
		ab := must(e.svc.AbortSigning(ctx, signers[1].p, s.Session.ID, store.SigningFailStateLost,
			sign(t, signers[1].key, SignAbortMessage(s.Session, me.ID, store.SigningFailStateLost))))
		if ab.Session.Status != store.SigningFailed || ab.Session.FailedBy == nil || *ab.Session.FailedBy != me.ID {
			t.Fatal("abort not recorded")
		}
	}
	wantErr(t, errOf(e.svc.StartSigning(ctx, signers[0].p, prop.ID)), ErrTooManyAttempts)
}

func TestSigningMembershipChangeFailsSession(t *testing.T) {
	e := newEnv(t)
	wid, users, prop, signers := e.approvedProposal(3)
	v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
	rp := &roundPayloads{w: map[int]qdraccoon.PolyVec{}}
	must(e.submit(signers[0], v, 1, e.payload(rp, v, 1, partyOf(e, v, signers[0]))))
	must(e.svc.RevokeParticipant(ctx, users[0].p, wid, mustMember(t, e, wid, users[2]).ID))
	got := must(e.svc.GetSigning(ctx, signers[0].p, v.Session.ID))
	if got.Session.Status != store.SigningFailed || got.Session.FailureReason != store.SigningFailMembershipChanged {
		t.Fatalf("got %s %s", got.Session.Status, got.Session.FailureReason)
	}
	if p := must(e.svc.GetProposal(ctx, signers[0].p, prop.ID)); p.Proposal.Status != store.ProposalSuperseded {
		t.Fatalf("proposal %s", p.Proposal.Status)
	}
	wantErr(t, errOf(e.svc.StartSigning(ctx, signers[0].p, prop.ID)), ErrClosed)
}

func TestConcurrentSigningStartOpensOneSession(t *testing.T) {
	e := newEnv(t)
	_, _, prop, signers := e.approvedProposal(5)
	var wg sync.WaitGroup
	ids := make([]uuid.UUID, 12)
	errs := make([]error, 12)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v, err := e.svc.StartSigning(ctx, signers[i%len(signers)].p, prop.ID)
			if err == nil {
				ids[i] = v.Session.ID
			}
			errs[i] = err
		}(i)
	}
	wg.Wait()
	for i, id := range ids {
		if errs[i] != nil || id != ids[0] {
			t.Fatalf("start %d: %v (%s vs %s)", i, errs[i], id, ids[0])
		}
	}
}

func TestAccountKeyRegistration(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	acct := e.account(wid, users[0], "Ops")
	pk := fakePublicKey(t)
	// No initialized key yet.
	wantErr(t, errOf(e.svc.RegisterAccountKey(ctx, users[0].p, wid, acct.ID, b64.EncodeToString(pk), "")), ErrSigningNotReady)
	e.fullCeremony(wid, users)
	k := must(e.registerAccountKey(users[0], wid, acct, pk))
	if len(k.Attestations) != 1 || k.Address == "" {
		t.Fatal("first registration")
	}
	k = must(e.registerAccountKey(users[1], wid, acct, pk))
	k = must(e.registerAccountKey(users[1], wid, acct, pk)) // idempotent
	if len(k.Attestations) != 2 {
		t.Fatalf("attestations %d", len(k.Attestations))
	}
	// A participant whose device derives a different key is refused (and audited).
	wantErr(t, errOf(e.registerAccountKey(users[2], wid, acct, fakePublicKey(t))), ErrAccountKeyMismatch)
	// Non-canonical key.
	bad := append([]byte{}, pk...)
	bad[32], bad[33] = 0xff, 0xff
	wantErr(t, errOf(e.svc.RegisterAccountKey(ctx, users[2].p, wid, acct.ID, b64.EncodeToString(bad), "")), ErrInvalid)
	v := must(e.svc.GetWallet(ctx, users[2].p, wid))
	if v.AccountKeys[acct.ID] == nil || v.AccountKeys[acct.ID].Address != k.Address {
		t.Fatal("wallet view lacks the account address")
	}
}

// Store level: a completed signature creates the execution atomically, and a
// later membership change does not supersede the already-signed proposal.
func TestSignedProposalSurvivesMembershipChange(t *testing.T) {
	e := newEnv(t)
	wid, users, prop, signers := e.approvedProposal(3)
	v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
	sw := e.st.SharedWallets()
	for round := 1; round <= 3; round++ {
		for i, idx := range v.Session.Act {
			if _, err := sw.AddSigningMessage(ctx, &store.SigningMessage{SessionID: v.Session.ID, Round: round, PartyIndex: idx,
				MemberID: v.Session.SignerMemberIDs[i], Payload: []byte{1}, DeviceSignature: []byte{1}}, e.clock, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	sig := make([]byte, qdraccoon.SignatureBytes)
	if _, err := sw.CompleteSigningSession(ctx, v.Session.ID, sig, e.clock); err != nil {
		t.Fatal(err)
	}
	if _, err := sw.CompleteSigningSession(ctx, v.Session.ID, sig, e.clock); !errors.Is(err, store.ErrAlreadySigned) {
		t.Fatalf("second completion: %v", err)
	}
	ex := must(sw.GetExecution(ctx, prop.ID))
	if ex.Status != store.ExecPending || ex.AccountAddress != v.Session.AccountAddress {
		t.Fatal("execution not created")
	}
	wantErr(t, sw.CreateSigningSession(ctx, &store.SigningSession{ID: uuid.New(), ProposalID: prop.ID, KeygenID: v.Session.KeygenID,
		MembershipVersion: v.Session.MembershipVersion, SID: rnd(t, 32), CreatedAt: e.clock}), store.ErrAlreadySigned)
	must(e.svc.RevokeParticipant(ctx, users[0].p, wid, mustMember(t, e, wid, users[2]).ID))
	if p := must(e.svc.GetProposal(ctx, users[0].p, prop.ID)); p.Proposal.Status != store.ProposalApproved || p.Lifecycle() != "signature_verified" {
		t.Fatalf("signed proposal changed: %s / %s", p.Proposal.Status, p.Lifecycle())
	}
	// Executions only move forward from the expected state.
	ex.Status = store.ExecSubmitting
	if err := sw.UpdateExecution(ctx, ex, store.ExecPending); err != nil {
		t.Fatal(err)
	}
	if err := sw.UpdateExecution(ctx, ex, store.ExecPending); !errors.Is(err, store.ErrConflict) {
		t.Fatal("double claim")
	}
}
