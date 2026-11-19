package sharedwallet

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// The backend treats envelopes as opaque bytes, so these tests use random
// ciphertexts of the right shape. Real HPKE sealing/opening and share
// verification are tested in packages/wallet-core (qd-shares.test.ts) and
// end-to-end over HTTP in packages/rpc (shared-keygen.integration.test.ts).

func rnd(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func (e *env) startKeygen(owner *participant, wid uuid.UUID) *KeygenView {
	e.t.Helper()
	v, err := e.svc.StartKeyGeneration(ctx, owner.p, wid)
	if err != nil {
		e.t.Fatalf("start keygen: %v", err)
	}
	return v
}

func partOf(v *KeygenView, memberID uuid.UUID) *store.KeygenParticipant {
	for _, p := range v.Parts {
		if p.MemberID == memberID {
			return p
		}
	}
	return nil
}

func (e *env) me(u *participant, wid uuid.UUID) *store.SharedMember {
	e.t.Helper()
	m, err := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, u.p.UserID)
	if err != nil {
		e.t.Fatal(err)
	}
	return m
}

func (e *env) registerKey(u *participant, wid uuid.UUID, kg *KeygenView) error {
	key := rnd(e.t, xwingPublicKeyBytes)
	m := e.me(u, wid)
	msg := KeygenKeyMessage(kg.KG, m.ID, partOf(kg, m.ID).PartyIndex, key)
	_, err := e.svc.RegisterEncryptionKey(ctx, u.p, wid, kg.KG.ID, b64.EncodeToString(key), sign(e.t, u.key, msg))
	return err
}

// deal stages one random envelope per party under fp and commits with the dealer's signature.
func (e *env) deal(dealer *participant, wid, kgID uuid.UUID, fp []byte) (map[uuid.UUID][]byte, error) {
	e.t.Helper()
	cts := map[uuid.UUID][]byte{}
	kg, parts, err := e.st.SharedWallets().GetKeyGeneration(ctx, kgID)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, p := range parts {
		ct := rnd(e.t, 33_000)
		cts[p.MemberID] = ct
		if err := e.svc.StageEnvelope(ctx, dealer.p, wid, kgID, p.MemberID, hex.EncodeToString(fp),
			b64.EncodeToString(rnd(e.t, xwingEncBytes)), b64.EncodeToString(ct)); err != nil {
			return nil, err
		}
	}
	_, parts, _ = e.st.SharedWallets().GetKeyGeneration(ctx, kgID)
	sig := sign(e.t, dealer.key, KeygenDealMessage(kg, fp, EnvelopesDigest(parts)))
	_, err = e.svc.CommitDeal(ctx, dealer.p, wid, kgID, hex.EncodeToString(fp), sig)
	return cts, err
}

func (e *env) ack(u *participant, wid, kgID uuid.UUID, fp []byte) (*KeygenView, error) {
	env, err := e.svc.MyEnvelope(ctx, u.p, wid, kgID)
	if err != nil {
		return nil, err
	}
	return e.svc.AcknowledgeShare(ctx, u.p, wid, kgID, hex.EncodeToString(fp), sign(e.t, u.key, KeygenAckMessage(env.KG, env.Part, fp)))
}

// must panics (failing the test) on error; usable as must(f()) for (T, error) results.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func errOf[T any](_ T, err error) error { return err }

func wantErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func (e *env) keyStatus(u *participant, wid uuid.UUID) string {
	e.t.Helper()
	v := must(e.svc.GetWallet(ctx, u.p, wid))
	return KeyInitStatus(v.Wallet, v.KeyGen)
}

// fullCeremony runs a complete key generation and returns its view and fingerprint.
func (e *env) fullCeremony(wid uuid.UUID, users []*participant) (*KeygenView, []byte) {
	e.t.Helper()
	kg := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg); err != nil {
			e.t.Fatal(err)
		}
	}
	fp := rnd(e.t, 32)
	if _, err := e.deal(users[0], wid, kg.KG.ID, fp); err != nil {
		e.t.Fatal(err)
	}
	var last *KeygenView
	for _, u := range users {
		last = must(e.ack(u, wid, kg.KG.ID, fp))
	}
	return last, fp
}

func TestKeygenCeremony(t *testing.T) {
	for _, tc := range []struct{ n, t int }{{3, 2}, {5, 3}} {
		e := newEnv(t)
		wid, users := e.wallet(tc.n)
		if s := e.keyStatus(users[1], wid); s != "not_initialized" {
			t.Fatalf("status %s", s)
		}
		kg := e.startKeygen(users[0], wid)
		if kg.KG.Threshold != tc.t || kg.KG.Parties != tc.n || kg.KG.DealerMemberID != e.me(users[0], wid).ID {
			t.Fatalf("snapshot %+v", kg.KG)
		}
		for i, u := range users { // party index = join order, owner first
			if p := partOf(kg, e.me(u, wid).ID); p == nil || p.PartyIndex != i+1 {
				t.Fatalf("party index of %s: %+v", u.name, p)
			}
		}
		if s := e.keyStatus(users[2], wid); s != "in_progress" {
			t.Fatalf("status %s", s)
		}
		for i, u := range users {
			if err := e.registerKey(u, wid, kg); err != nil {
				t.Fatal(err)
			}
			cur := must(e.svc.CurrentKeyGeneration(ctx, u.p, wid))
			want := store.KeygenCollectingKeys
			if i == len(users)-1 {
				want = store.KeygenDealing
			}
			if cur.KG.Status != want {
				t.Fatalf("after %d keys: %s", i+1, cur.KG.Status)
			}
		}
		fp := rnd(t, 32)
		cts := must(e.deal(users[0], wid, kg.KG.ID, fp))
		if s := e.keyStatus(users[1], wid); s != "awaiting_provisioning" {
			t.Fatalf("status %s", s)
		}
		for i, u := range users {
			env := must(e.svc.MyEnvelope(ctx, u.p, wid, kg.KG.ID))
			if string(env.Part.EnvelopeCT) != string(cts[env.Part.MemberID]) || env.Part.MemberID != e.me(u, wid).ID {
				t.Fatal("participant received someone else's envelope")
			}
			v := must(e.ack(u, wid, kg.KG.ID, fp))
			w := must(e.st.SharedWallets().GetWallet(ctx, wid))
			if i < len(users)-1 && (w.KeyStatus == store.KeyActive || v.KG.Status != store.KeygenAwaitingProvisioning) {
				t.Fatalf("wallet initialized after %d/%d acknowledgements", i+1, tc.n)
			}
			if partOf(v, env.Part.MemberID).EnvelopeCT != nil {
				t.Fatal("envelope not wiped after acknowledgement")
			}
		}
		w := must(e.st.SharedWallets().GetWallet(ctx, wid))
		if w.KeyStatus != store.KeyActive || *w.KeyGenerationID != kg.KG.ID || string(w.KeyFingerprint) != string(fp) {
			t.Fatalf("wallet key not activated: %+v", w)
		}
		if s := e.keyStatus(users[1], wid); s != "initialized" {
			t.Fatalf("status %s", s)
		}
		wantErr(t, errOf(e.svc.StartKeyGeneration(ctx, users[0].p, wid)), ErrAlreadyInitialized)
	}
}

func TestKeygenAuthorization(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	outsider := e.newUser("outsider")
	wantErr(t, errOf(e.svc.StartKeyGeneration(ctx, users[1].p, wid)), ErrForbidden)
	wantErr(t, errOf(e.svc.StartKeyGeneration(ctx, outsider.p, wid)), ErrNotFound)
	otherDevice := *users[0].p
	otherDevice.DeviceID = uuid.New()
	wantErr(t, errOf(e.svc.StartKeyGeneration(ctx, &otherDevice, wid)), ErrWrongDevice)

	kg := e.startKeygen(users[0], wid)
	wantErr(t, errOf(e.svc.StartKeyGeneration(ctx, users[0].p, wid)), ErrKeygenInProgress)
	wantErr(t, errOf(e.svc.CurrentKeyGeneration(ctx, outsider.p, wid)), ErrNotFound)

	// Key registration is bound to the participant's own device and slot.
	key := rnd(t, xwingPublicKeyBytes)
	m1 := e.me(users[1], wid)
	goodMsg := KeygenKeyMessage(kg.KG, m1.ID, 2, key)
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, users[1].p, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, users[2].key, goodMsg))), ErrKeygenSignature)
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, users[1].p, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, users[1].key, KeygenKeyMessage(kg.KG, m1.ID, 3, key)))), ErrKeygenSignature)
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, users[1].p, wid, kg.KG.ID, b64.EncodeToString(key[:100]), sign(t, users[1].key, goodMsg))), ErrInvalid)
	otherDevice1 := *users[1].p
	otherDevice1.DeviceID = uuid.New()
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, &otherDevice1, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, users[1].key, goodMsg))), ErrWrongDevice)
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, outsider.p, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, outsider.key, goodMsg))), ErrNotFound)
	must(e.svc.RegisterEncryptionKey(ctx, users[1].p, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, users[1].key, goodMsg)))
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, users[1].p, wid, kg.KG.ID, b64.EncodeToString(key), sign(t, users[1].key, goodMsg))), ErrAlreadyRegistered)

	// Nothing can be dealt or fetched before every key is registered.
	fp := hex.EncodeToString(rnd(t, 32))
	err := e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, m1.ID, fp, b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 33000)))
	wantErr(t, err, ErrKeygenNotOpen)
	wantErr(t, errOf(e.svc.MyEnvelope(ctx, users[1].p, wid, kg.KG.ID)), ErrKeygenNotOpen)
	for _, u := range []*participant{users[0], users[2]} {
		if err := e.registerKey(u, wid, kg); err != nil {
			t.Fatal(err)
		}
	}

	// Only the dealer may stage or commit envelopes.
	err = e.svc.StageEnvelope(ctx, users[1].p, wid, kg.KG.ID, m1.ID, fp, b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 33000)))
	wantErr(t, err, ErrForbidden)
	err = e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, outsiderID(), fp, b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 33000)))
	wantErr(t, err, ErrNotInKeyGeneration)
	err = e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, m1.ID, fp, b64.EncodeToString(rnd(t, 100)), b64.EncodeToString(rnd(t, 33000)))
	wantErr(t, err, ErrInvalid)
	err = e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, m1.ID, fp, b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 50_000)))
	wantErr(t, err, ErrInvalid)

	fpb, _ := hex.DecodeString(fp)
	cts := must(e.deal(users[0], wid, kg.KG.ID, fpb))

	// Each participant gets only their own envelope; others get nothing.
	for _, u := range users {
		env := must(e.svc.MyEnvelope(ctx, u.p, wid, kg.KG.ID))
		for id, ct := range cts {
			if id != env.Part.MemberID && string(ct) == string(env.Part.EnvelopeCT) {
				t.Fatal("envelope leaked to another participant")
			}
		}
	}
	wantErr(t, errOf(e.svc.MyEnvelope(ctx, outsider.p, wid, kg.KG.ID)), ErrNotFound)
	wantErr(t, errOf(e.svc.MyEnvelope(ctx, &otherDevice1, wid, kg.KG.ID)), ErrWrongDevice)

	// Acknowledgements: forged, wrong fingerprint, duplicate.
	env := must(e.svc.MyEnvelope(ctx, users[1].p, wid, kg.KG.ID))
	ackMsg := KeygenAckMessage(env.KG, env.Part, fpb)
	wantErr(t, errOf(e.svc.AcknowledgeShare(ctx, users[1].p, wid, kg.KG.ID, fp, sign(t, users[2].key, ackMsg))), ErrKeygenSignature)
	wrongFP := hex.EncodeToString(rnd(t, 32))
	wantErr(t, errOf(e.svc.AcknowledgeShare(ctx, users[1].p, wid, kg.KG.ID, wrongFP, sign(t, users[1].key, ackMsg))), ErrFingerprintMismatch)
	must(e.svc.AcknowledgeShare(ctx, users[1].p, wid, kg.KG.ID, fp, sign(t, users[1].key, ackMsg)))
	wantErr(t, errOf(e.svc.AcknowledgeShare(ctx, users[1].p, wid, kg.KG.ID, fp, sign(t, users[1].key, ackMsg))), ErrAlreadyProvisioned)
	wantErr(t, errOf(e.svc.MyEnvelope(ctx, users[1].p, wid, kg.KG.ID)), ErrAlreadyProvisioned)

	// Only the dealer may cancel; a party may report its own failure.
	wantErr(t, errOf(e.svc.FailKeyGeneration(ctx, users[2].p, wid, kg.KG.ID, store.KeygenFailCancelled)), ErrForbidden)
	wantErr(t, errOf(e.svc.FailKeyGeneration(ctx, users[2].p, wid, kg.KG.ID, "because")), ErrInvalidFailureReason)
	wantErr(t, errOf(e.svc.FailKeyGeneration(ctx, users[2].p, wid, kg.KG.ID, store.KeygenFailExpired)), ErrInvalidFailureReason)
}

func outsiderID() uuid.UUID { return uuid.New() }

func TestKeygenDealIntegrity(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	kg := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg); err != nil {
			t.Fatal(err)
		}
	}
	fpA, fpB := rnd(t, 32), rnd(t, 32)
	parts := kg.Parts
	stage := func(p *store.KeygenParticipant, fp []byte) {
		t.Helper()
		if err := e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, p.MemberID, hex.EncodeToString(fp),
			b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 33000))); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(fp []byte, signWith *participant) error {
		_, cur, _ := e.st.SharedWallets().GetKeyGeneration(ctx, kg.KG.ID)
		_, err := e.svc.CommitDeal(ctx, users[0].p, wid, kg.KG.ID, hex.EncodeToString(fp), sign(t, signWith.key, KeygenDealMessage(kg.KG, fp, EnvelopesDigest(cur))))
		return err
	}
	// Missing envelope.
	stage(parts[0], fpA)
	stage(parts[1], fpA)
	wantErr(t, commit(fpA, users[0]), ErrKeygenIncomplete)
	// Envelopes from two different dealer runs cannot be committed together.
	stage(parts[2], fpB)
	wantErr(t, commit(fpA, users[0]), ErrKeygenIncomplete)
	wantErr(t, commit(fpB, users[0]), ErrKeygenIncomplete)
	// A retry restages everything under one fingerprint; a non-dealer signature is refused.
	for _, p := range parts {
		stage(p, fpB)
	}
	wantErr(t, commit(fpB, users[1]), ErrKeygenSignature)
	if err := commit(fpB, users[0]); err != nil {
		t.Fatal(err)
	}
	// Once committed, envelopes are frozen.
	err := e.svc.StageEnvelope(ctx, users[0].p, wid, kg.KG.ID, parts[0].MemberID, hex.EncodeToString(fpB),
		b64.EncodeToString(rnd(t, xwingEncBytes)), b64.EncodeToString(rnd(t, 33000)))
	wantErr(t, err, ErrKeygenNotOpen)
	wantErr(t, commit(fpB, users[0]), ErrKeygenNotOpen)
}

func TestKeygenPartialFailureAndRecovery(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(5)
	kg := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg); err != nil {
			t.Fatal(err)
		}
	}
	fp := rnd(t, 32)
	must(e.deal(users[0], wid, kg.KG.ID, fp))
	for _, u := range users[:3] {
		must(e.ack(u, wid, kg.KG.ID, fp))
	}
	// Two participants never finish: the ceremony expires and the wallet stays uninitialized.
	e.clock = e.clock.Add(keygenTTL + time.Minute)
	if s := e.keyStatus(users[0], wid); s != "failed" {
		t.Fatalf("status %s", s)
	}
	cur, parts, _ := e.st.SharedWallets().GetKeyGeneration(ctx, kg.KG.ID)
	if cur.FailureReason != store.KeygenFailExpired {
		t.Fatalf("reason %q", cur.FailureReason)
	}
	for _, p := range parts {
		if p.EnvelopeCT != nil {
			t.Fatal("envelope survived a failed ceremony")
		}
	}
	wantErr(t, errOf(e.ack(users[3], wid, kg.KG.ID, fp)), ErrKeygenNotOpen)
	if w := must(e.st.SharedWallets().GetWallet(ctx, wid)); w.KeyStatus != store.KeyNone {
		t.Fatalf("key status %s", w.KeyStatus)
	}

	// A participant whose share fails verification aborts the next attempt.
	kg2 := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg2); err != nil {
			t.Fatal(err)
		}
	}
	must(e.deal(users[0], wid, kg2.KG.ID, rnd(t, 32)))
	must(e.svc.FailKeyGeneration(ctx, users[4].p, wid, kg2.KG.ID, store.KeygenFailVerification))
	if s := e.keyStatus(users[1], wid); s != "failed" {
		t.Fatalf("status %s", s)
	}
	wantErr(t, errOf(e.svc.FailKeyGeneration(ctx, users[0].p, wid, kg2.KG.ID, store.KeygenFailCancelled)), ErrKeygenNotOpen)

	// The dealer can cancel, then a clean attempt succeeds.
	kg3 := e.startKeygen(users[0], wid)
	must(e.svc.FailKeyGeneration(ctx, users[0].p, wid, kg3.KG.ID, store.KeygenFailCancelled))
	done, _ := e.fullCeremony(wid, users)
	if done.KG.Status != store.KeygenComplete || e.keyStatus(users[2], wid) != "initialized" {
		t.Fatal("recovery ceremony did not complete")
	}
}

func TestKeygenMembershipChanges(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(4)

	// A join during the ceremony invalidates it.
	kg := e.startKeygen(users[0], wid)
	newcomer := e.newUser("P5")
	_, code, _ := e.svc.CreateInvitation(ctx, users[0].p, wid, "P5")
	if _, _, err := e.svc.AcceptInvitation(ctx, newcomer.p, code, "P5"); err != nil {
		t.Fatal(err)
	}
	cur, _, _ := e.st.SharedWallets().GetKeyGeneration(ctx, kg.KG.ID)
	if cur.Status != store.KeygenFailed || cur.FailureReason != store.KeygenFailMembershipChanged {
		t.Fatalf("ceremony after join: %s %s", cur.Status, cur.FailureReason)
	}
	wantErr(t, e.registerKey(users[1], wid, kg), ErrKeygenNotOpen)

	// A fresh ceremony covers all 5 with T = 3 and completes.
	all := append(users, newcomer)
	done, _ := e.fullCeremony(wid, all)
	if done.KG.Parties != 5 || done.KG.Threshold != 3 {
		t.Fatalf("snapshot %d-of-%d", done.KG.Threshold, done.KG.Parties)
	}

	// Approved proposals under this membership are ready for a signing session.
	acct := e.account(wid, users[0], "Ops")
	prop := e.propose(wid, users[0], acct.ID)
	for _, u := range []*participant{all[4], all[1], all[2]} {
		must(e.svc.CastVote(ctx, u.p, prop.ID, e.signedVote(u, prop, store.VoteApprove)))
	}
	pv := must(e.svc.GetProposal(ctx, users[0].p, prop.ID))
	if !pv.KeyReady || len(pv.SignerIndexes) != 3 || pv.SignerIndexes[0] != 2 || pv.SignerIndexes[2] != 5 {
		t.Fatalf("signing readiness %v %v", pv.KeyReady, pv.SignerIndexes)
	}

	// Revocation after initialization: the key is stale and must be regenerated.
	must(e.svc.RevokeParticipant(ctx, users[0].p, wid, e.me(users[3], wid).ID))
	if s := e.keyStatus(users[0], wid); s != "rekey_required" {
		t.Fatalf("status %s", s)
	}
	pv = must(e.svc.GetProposal(ctx, users[0].p, prop.ID))
	if pv.Proposal.Status != store.ProposalSuperseded || pv.KeyReady {
		t.Fatal("old proposal still signable after revocation")
	}
	remaining := []*participant{users[0], users[1], users[2], newcomer}
	prop2 := e.propose(wid, users[0], acct.ID)
	for _, u := range remaining[:2] {
		must(e.svc.CastVote(ctx, u.p, prop2.ID, e.signedVote(u, prop2, store.VoteApprove)))
	}
	if pv2 := must(e.svc.GetProposal(ctx, users[0].p, prop2.ID)); pv2.Proposal.Status != store.ProposalApproved || pv2.KeyReady {
		t.Fatal("proposal treated as signable with a key for another membership")
	}
	// The revoked participant cannot take part in the rekey.
	rekey := e.startKeygen(users[0], wid)
	if rekey.KG.Parties != 4 || rekey.KG.Threshold != 2 || partOf(rekey, e.me(users[1], wid).ID) == nil {
		t.Fatalf("rekey snapshot %+v", rekey.KG)
	}
	key := rnd(t, xwingPublicKeyBytes)
	revokedMsg := KeygenKeyMessage(rekey.KG, uuid.New(), 4, key)
	wantErr(t, errOf(e.svc.RegisterEncryptionKey(ctx, users[3].p, wid, rekey.KG.ID, b64.EncodeToString(key), sign(t, users[3].key, revokedMsg))), ErrNotFound)
	if s := e.keyStatus(users[0], wid); s != "in_progress" {
		t.Fatalf("status %s", s)
	}
}

func TestKeygenConcurrentAcknowledgements(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(10)
	kg := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg); err != nil {
			t.Fatal(err)
		}
	}
	fp := rnd(t, 32)
	must(e.deal(users[0], wid, kg.KG.ID, fp))
	var wg sync.WaitGroup
	errs := make(chan error, 2*len(users))
	for _, u := range users {
		for range 2 { // each participant acknowledges twice, concurrently
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := e.ack(u, wid, kg.KG.ID, fp)
				errs <- err
			}()
		}
	}
	wg.Wait()
	close(errs)
	ok, dup := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrAlreadyProvisioned):
			dup++
		default:
			t.Fatal(err)
		}
	}
	if ok != 10 || dup != 10 {
		t.Fatalf("ok=%d dup=%d", ok, dup)
	}
	if w := must(e.st.SharedWallets().GetWallet(ctx, wid)); w.KeyStatus != store.KeyActive {
		t.Fatal("not initialized")
	}
}

func TestKeygenConcurrentStart(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	var wg sync.WaitGroup
	var mu sync.Mutex
	started := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.svc.StartKeyGeneration(ctx, users[0].p, wid)
			if err == nil {
				mu.Lock()
				started++
				mu.Unlock()
			} else if !errors.Is(err, ErrKeygenInProgress) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if started != 1 {
		t.Fatalf("%d ceremonies started", started)
	}
}

// No API response or table column carries plaintext key material.
func TestKeygenExposesNoSecretMaterial(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	kg := e.startKeygen(users[0], wid)
	for _, u := range users {
		if err := e.registerKey(u, wid, kg); err != nil {
			t.Fatal(err)
		}
	}
	must(e.deal(users[0], wid, kg.KG.ID, rnd(t, 32)))
	v := must(e.svc.CurrentKeyGeneration(ctx, users[1].p, wid))
	body, _ := json.Marshal(keygenJSON(v))
	wv := must(e.svc.GetWallet(ctx, users[1].p, wid))
	wbody, _ := json.Marshal(viewJSON(wv))
	for _, s := range []string{string(body), string(wbody)} {
		for _, forbidden := range []string{`"ct"`, `"enc"`, "share\"", "tFull", "chaincode", "seed", "secret"} {
			if strings.Contains(s, forbidden) {
				t.Fatalf("response contains %s", forbidden)
			}
		}
	}
	schema, err := os.ReadFile("../../migrations/00009_shared_key_generation.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(schema), "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "--") {
			continue
		}
		for _, forbidden := range []string{"share ", "msk", "tfull", "chaincode", "chain_code", "seed", "secret", "private"} {
			if strings.Contains(strings.ToLower(l), forbidden) {
				t.Fatalf("schema column looks like secret material: %q", l)
			}
		}
	}
}
