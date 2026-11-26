package nativecustody

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/blockchain/btc"
	"github.com/qdwallet/wallet-api/internal/blockchain/hedera"
	"github.com/qdwallet/wallet-api/internal/store"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var testContext = context.Background()

type fixtureEntry struct {
	Chain    string `json:"chain"`
	Policy   Policy `json:"policy"`
	PolicyID string `json:"policyId"`
}
type wireFixture struct {
	MigrationID string `json:"migrationId"`
	Bitcoin     struct {
		Proposal json.RawMessage `json:"proposal"`
		TxID     string          `json:"txid"`
		Coin     MigrationCoin   `json:"coin"`
		Script   string          `json:"script"`
	} `json:"bitcoin"`
	Hedera struct {
		Source json.RawMessage `json:"source"`
		Target json.RawMessage `json:"target"`
	} `json:"hedera"`
}
type migrationStore struct {
	store.Store
	shared *migrationShared
}

func (s *migrationStore) SharedWallets() store.SharedWallets { return s.shared }

type migrationShared struct {
	store.SharedWallets
	wallets  map[uuid.UUID]*store.SharedWallet
	members  map[uuid.UUID][]*store.SharedMember
	keygens  map[uuid.UUID]*store.KeyGeneration
	parts    map[uuid.UUID][]*store.KeygenParticipant
	accounts map[uuid.UUID]*store.SharedAccount
}

func (s *migrationShared) GetWallet(_ context.Context, id uuid.UUID) (*store.SharedWallet, error) {
	w := s.wallets[id]
	if w == nil {
		return nil, store.ErrNotFound
	}
	return w, nil
}
func (s *migrationShared) GetActiveMemberByUser(_ context.Context, wid, uid uuid.UUID) (*store.SharedMember, error) {
	for _, m := range s.members[wid] {
		if m.UserID == uid && m.Status == store.MemberActive {
			return m, nil
		}
	}
	return nil, store.ErrNotFound
}
func (s *migrationShared) ListMembers(_ context.Context, id uuid.UUID) ([]*store.SharedMember, error) {
	return s.members[id], nil
}
func (s *migrationShared) GetKeyGeneration(_ context.Context, id uuid.UUID) (*store.KeyGeneration, []*store.KeygenParticipant, error) {
	return s.keygens[id], s.parts[id], nil
}
func (s *migrationShared) GetAccount(_ context.Context, wid, aid uuid.UUID) (*store.SharedAccount, error) {
	a := s.accounts[aid]
	if a == nil || a.WalletID != wid {
		return nil, store.ErrNotFound
	}
	return a, nil
}

type migrationRooms map[string]map[string]json.RawMessage

func (r migrationRooms) NativeRooms(_ context.Context, wid string) (map[string]json.RawMessage, error) {
	return r[wid], nil
}
func (r migrationRooms) SessionMessages(context.Context, string, string, string, int64, string) (json.RawMessage, error) {
	return json.RawMessage("[]"), nil
}

type bitcoinProof struct {
	txs     map[string]*btc.EsploraTx
	depth   map[string]int64
	offline bool
}

func (b *bitcoinProof) NativeMigrationIdentity(context.Context) error {
	if b.offline {
		return errors.New("offline")
	}
	return nil
}
func (b *bitcoinProof) NativeMigrationAddress(context.Context, string) (bool, []btc.UTXO, error) {
	return false, nil, nil
}
func (b *bitcoinProof) NativeMigrationTransaction(_ context.Context, id string) (*btc.EsploraTx, int64, error) {
	if b.offline || b.txs[id] == nil {
		return nil, 0, errors.New("missing")
	}
	return b.txs[id], b.depth[id], nil
}

type hederaProof struct {
	account  *hedera.MirrorAccount
	receipts map[string]*hedera.NativeReceipt
}

func (h *hederaProof) NativeMigrationAccount(context.Context, string) (*hedera.MirrorAccount, error) {
	return h.account, nil
}
func (h *hederaProof) NativeMigrationReceipt(_ context.Context, id string) (*hedera.NativeReceipt, error) {
	if r := h.receipts[id]; r != nil {
		return r, nil
	}
	return &hedera.NativeReceipt{}, nil
}

type migrationEnv struct {
	c       *Coordinator
	st      *migrationShared
	entries []fixtureEntry
	wire    wireFixture
	actors  []*auth.Principal
	keys    []*ecdsa.PrivateKey
	btc     *bitcoinProof
	hedera  *hederaProof
	now     time.Time
}

func signDevice(t *testing.T, key *ecdsa.PrivateKey, value any) string {
	t.Helper()
	body, _ := json.Marshal(value)
	hash := sha256.Sum256(body)
	r, s, err := ecdsa.Sign(rand.Reader, key, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	s.FillBytes(raw[32:])
	return base64.RawURLEncoding.EncodeToString(raw)
}
func jsonFile(t *testing.T, name string, value any) {
	t.Helper()
	raw, err := os.ReadFile("../../../../docs/api/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, value); err != nil {
		t.Fatal(err)
	}
}
func newMigrationEnv(t *testing.T) *migrationEnv {
	t.Helper()
	e := &migrationEnv{}
	jsonFile(t, "native-policy-fixture.json", &e.entries)
	jsonFile(t, "native-migration-fixture.json", &e.wire)
	var proposal nativeProposal
	_ = json.Unmarshal(e.wire.Hedera.Source, &proposal)
	e.now = time.UnixMilli(proposal.ExpiresAt - 90000).UTC()
	e.st = &migrationShared{wallets: map[uuid.UUID]*store.SharedWallet{}, members: map[uuid.UUID][]*store.SharedMember{}, keygens: map[uuid.UUID]*store.KeyGeneration{}, parts: map[uuid.UUID][]*store.KeygenParticipant{}, accounts: map[uuid.UUID]*store.SharedAccount{}}
	for i := 0; i < 3; i++ {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		e.keys = append(e.keys, key)
		e.actors = append(e.actors, &auth.Principal{UserID: uuid.New(), DeviceID: uuid.New()})
	}
	rooms := map[string]migrationRooms{"bitcoin": {}, "hedera": {}}
	for side := 0; side < 2; side++ {
		p := e.entries[side*2].Policy
		wid, aid, kid := uuid.MustParse(p.Context.WalletID), uuid.MustParse(p.Context.AccountID), uuid.MustParse(p.Context.KeygenID)
		e.st.wallets[wid] = &store.SharedWallet{ID: wid, MembershipVersion: 3, KeyGenerationID: &kid, KeyStatus: store.KeyActive, NativeCustodyLocked: true}
		e.st.accounts[aid] = &store.SharedAccount{ID: aid, WalletID: wid, DerivationIndex: 7}
		e.st.keygens[kid] = &store.KeyGeneration{ID: kid, WalletID: wid, Threshold: 2, Parties: 3}
		for i, enrollment := range p.Members {
			der, _ := x509.MarshalPKIXPublicKey(&e.keys[i].PublicKey)
			role := store.RoleMember
			if i == side {
				role = store.RoleOwner
			}
			member := &store.SharedMember{ID: uuid.MustParse(enrollment.ParticipantID), WalletID: wid, UserID: e.actors[i].UserID, DeviceID: e.actors[i].DeviceID, DevicePublicKey: der, DisplayName: fmt.Sprintf("Participant %d", i), Role: role, Status: store.MemberActive}
			e.st.members[wid] = append(e.st.members[wid], member)
			e.st.parts[kid] = append(e.st.parts[kid], &store.KeygenParticipant{MemberID: member.ID, PartyIndex: i + 1})
		}
		for chainIndex, chain := range []string{"bitcoin", "hedera"} {
			entry := e.entries[side*2+chainIndex]
			messages := []roomMessage{}
			for i, member := range e.st.members[wid] {
				kinds := []string{"enrollment", "policy"}
				if side == 0 && chain == "hedera" {
					kinds = append(kinds, "binding")
				}
				for _, kind := range kinds {
					var value any = entry.Policy.Members[i]
					if kind == "policy" {
						value = map[string]any{"policyId": entry.PolicyID}
					}
					if kind == "binding" {
						value = map[string]any{"policyId": entry.PolicyID, "accountId": "0.0.9001"}
					}
					body, _ := json.Marshal(value)
					payload := base64.RawURLEncoding.EncodeToString(body)
					sum := sha256.Sum256([]byte(payload))
					domain := "QDWallet-BitcoinRelay/v1"
					if chain == "hedera" {
						domain = "QDWallet-HederaRelay/v1"
					}
					message := roomMessage{ID: uuid.NewString(), From: member.ID.String(), Kind: kind, Session: "enrollment", Payload: payload, Signature: signDevice(t, e.keys[i], []any{domain, wid.String(), aid.String(), kid.String(), int64(3), kind, "enrollment", fmt.Sprintf("%x", sum)})}
					messages = append(messages, message)
				}
			}
			raw, _ := json.Marshal(messages)
			rooms[chain][wid.String()] = map[string]json.RawMessage{wid.String() + "|" + aid.String() + "|" + kid.String() + "|3": raw}
		}
	}
	e.btc = &bitcoinProof{txs: map[string]*btc.EsploraTx{}, depth: map[string]int64{}}
	e.btc.txs[e.wire.Bitcoin.Coin.TxID] = &btc.EsploraTx{TxID: e.wire.Bitcoin.Coin.TxID, Vout: []btc.EsploraVout{{Value: 100000, Scriptpubkey: e.wire.Bitcoin.Script}}}
	e.btc.depth[e.wire.Bitcoin.Coin.TxID] = 6
	f := false
	key, _ := e.entries[1].Policy.HederaKey()
	stamp := fmt.Sprintf("%d.000000001", e.now.Unix())
	e.hedera = &hederaProof{account: &hedera.MirrorAccount{Account: "0.0.9001", Deleted: &f, ReceiverSignatureRequired: &f, Key: hedera.MirrorKey{Type: "ProtobufEncoded", Key: key}, Balance: hedera.MirrorBalance{Balance: 1000000000, Timestamp: stamp}}, receipts: map[string]*hedera.NativeReceipt{}}
	repo, err := NewMigrationRepository(nil, filepath.Join(t.TempDir(), "migration.json"))
	if err != nil {
		t.Fatal(err)
	}
	e.c = NewCoordinator(&migrationStore{shared: e.st}, repo, rooms["bitcoin"], rooms["hedera"], e.btc, e.hedera)
	e.c.now = func() time.Time { return e.now }
	return e
}
func (e *migrationEnv) draft(t *testing.T) Migration {
	t.Helper()
	source, target := e.entries[0].Policy.Context, e.entries[2].Policy.Context
	m, err := e.c.Create(testContext, e.actors[1], source.WalletID, DraftInput{TargetWalletID: target.WalletID, Mappings: []AccountMapping{{SourceAccountID: source.AccountID, TargetAccountID: target.AccountID, BitcoinCoins: []MigrationCoin{e.wire.Bitcoin.Coin}, BitcoinMaxFee: "100000", HederaMaxFee: "100000000"}}})
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func (e *migrationEnv) confirm(t *testing.T, m Migration, side string, index int) Migration {
	t.Helper()
	next, err := e.c.Approve(testContext, e.actors[index], m.Manifest.ID, side, signDevice(t, e.keys[index], ApprovalMessage(m, side)))
	if err != nil {
		t.Fatal(err)
	}
	return next
}
func (e *migrationEnv) freeze(t *testing.T, m Migration) Migration {
	for _, side := range []string{"source", "target"} {
		for _, index := range []int{0, 1} {
			m = e.confirm(t, m, side, index)
		}
	}
	return m
}
func TestMigrationRequiresBothQuorumsAndKeepsOldRoster(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.draft(t)
	// A healthy old member who owns the replacement can recover without the old owner.
	if m.Status != "draft" {
		t.Fatal(m.Status)
	}
	if _, err := e.c.Approve(testContext, &auth.Principal{UserID: e.actors[0].UserID, DeviceID: uuid.New()}, m.Manifest.ID, "source", signDevice(t, e.keys[0], ApprovalMessage(m, "source"))); err == nil {
		t.Fatal("wrong device approved")
	}
	if _, err := e.c.Approve(testContext, e.actors[0], m.Manifest.ID, "source", signDevice(t, e.keys[0], ApprovalMessage(m, "target"))); err == nil {
		t.Fatal("cross-side approval accepted")
	}
	m = e.confirm(t, m, "source", 0)
	m = e.confirm(t, m, "source", 1)
	if m.Status != "draft" {
		t.Fatal("old quorum alone activated migration")
	}
	m = e.confirm(t, m, "target", 0)
	m = e.confirm(t, m, "target", 1)
	if m.Status != "frozen" {
		t.Fatal(m.Status)
	}
	if err := e.c.Guard("bitcoin")(testContext, m.Manifest.SourceWalletID, m.Manifest.Intents[0].SourceAccountID, "proposal", uuid.NewString(), "e30"); err == nil {
		t.Fatal("ordinary signing was not frozen")
	}
	if _, err := e.c.Cancel(testContext, e.actors[0], m.Manifest.ID); err == nil {
		t.Fatal("frozen migration cancelled")
	}
	for _, w := range e.st.wallets {
		if w.MembershipVersion != 3 {
			t.Fatal("old roster changed")
		}
	}
	reopened, err := NewMigrationRepository(nil, e.c.repo.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := reopened.Get(testContext, m.Manifest.ID)
	if err != nil || saved.Status != "frozen" {
		t.Fatal("migration was not recoverable", err)
	}
	if _, err = e.c.repo.Update(testContext, m.Manifest.ID, 1, func(*Migration) error { return nil }); !errors.Is(err, ErrMigrationConflict) {
		t.Fatal("stale writer replaced migration")
	}
}
func TestMigrationWireContractsAndRejectedMutations(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.freeze(t, e.draft(t))
	var btcIntent, hIntent MigrationIntent
	for _, i := range m.Manifest.Intents {
		if i.Chain == "bitcoin" {
			btcIntent = i
		} else {
			hIntent = i
		}
	}
	// The native fixture uses a fixed migration id. Rebind only public metadata;
	// the Hedera frozen memo must be regenerated, so its exact-byte parser is
	// checked separately against the fixed fixture below.
	var p map[string]any
	_ = json.Unmarshal(e.wire.Bitcoin.Proposal, &p)
	p["migration"].(map[string]any)["id"] = m.Manifest.ID
	p["expiresAt"] = e.now.Add(time.Hour).UnixMilli()
	raw, _ := json.Marshal(p)
	m, err := e.c.Register(testContext, e.actors[0], m.Manifest.ID, RegisterInput{IntentID: btcIntent.ID, TxID: e.wire.Bitcoin.TxID, SourceProposal: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Attempts) != 1 {
		t.Fatal("attempt missing")
	}
	p["recipient"] = "changed"
	changed, _ := json.Marshal(p)
	if _, err = e.c.Register(testContext, e.actors[0], m.Manifest.ID, RegisterInput{IntentID: btcIntent.ID, TxID: e.wire.Bitcoin.TxID, SourceProposal: changed}); err == nil {
		t.Fatal("destination mutation accepted")
	}
	if err = e.c.Guard("bitcoin")(testContext, m.Manifest.TargetWalletID, btcIntent.TargetAccountID, "r1", m.Attempts[0].Session, "e30"); err == nil {
		t.Fatal("new Bitcoin group signed old funds")
	}
	native, _, err := decodeProposal(e.wire.Hedera.Source)
	if err != nil {
		t.Fatal(err)
	}
	targetKey, _ := e.entries[3].Policy.HederaKey()
	hIntent.TargetKey = targetKey
	digest := Hash([]any{"QDWallet-HederaNativeIntent/v1", native.PolicyID, native.Kind, native.From, native.To, native.Amount, native.MaxFee, native.TransactionID, native.MigrationID, e.entries[3].PolicyID})
	hashBytes, _ := hex.DecodeString(digest)
	memo := "QDWallet:" + native.ID + ":" + base64.RawURLEncoding.EncodeToString(hashBytes)
	if err = reviewedHedera(native, hIntent, memo); err != nil {
		t.Fatal(err)
	}
	native.MaxFee = "1"
	if reviewedHedera(native, hIntent, memo) == nil {
		t.Fatal("hidden native fee accepted")
	}
	var review struct {
		Manifest MigrationManifest `json:"manifest"`
		Digest   string            `json:"digest"`
	}
	jsonFile(t, "native-migration-review-fixture.json", &review)
	if Hash(ManifestFields(review.Manifest)) != review.Digest {
		t.Fatal("Go/TypeScript review digest differs")
	}
	review.Manifest.Intents[0].BitcoinCoins[0].Vout++
	if Hash(ManifestFields(review.Manifest)) == review.Digest {
		t.Fatal("coin snapshot not committed")
	}
}
func TestMigrationNeedsEveryNominatedCoinAndExactHederaKey(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.freeze(t, e.draft(t))
	var b, h MigrationIntent
	for _, i := range m.Manifest.Intents {
		if i.Chain == "bitcoin" {
			b = i
		} else {
			h = i
		}
	}
	// Empty address views never count as completion. Only registered proofs count.
	pending := e.c.checkBitcoin(testContext, b, nil, b.BitcoinCoins)
	if pending.State == "confirmed" {
		t.Fatal("empty history counted as migration")
	}
	txid := e.wire.Bitcoin.TxID
	fee := int64(1000)
	parent := e.btc.txs[e.wire.Bitcoin.Coin.TxID].Vout[0]
	e.btc.txs[txid] = &btc.EsploraTx{TxID: txid, Vin: []btc.EsploraVin{{TxID: e.wire.Bitcoin.Coin.TxID, Vout: 0, Prevout: &parent}}, Vout: []btc.EsploraVout{{Value: 100000 - fee, Scriptpubkey: b.DestinationScript, ScriptpubkeyAddress: b.Destination}}}
	e.btc.depth[txid] = 5
	attempts := []MigrationAttempt{{IntentID: b.ID, TxID: txid, MaxFee: "1000"}}
	if e.c.checkBitcoin(testContext, b, attempts, b.BitcoinCoins).State == "confirmed" {
		t.Fatal("five confirmations activated")
	}
	e.btc.depth[txid] = 6
	if e.c.checkBitcoin(testContext, b, attempts, b.BitcoinCoins).State != "confirmed" {
		t.Fatal("valid sweep rejected")
	}
	_, otherScript, _ := b.SourcePolicy.BitcoinOutput(1, 0)
	parent.Scriptpubkey = otherScript
	if e.c.checkBitcoin(testContext, b, attempts, b.BitcoinCoins).State == "confirmed" {
		t.Fatal("substituted previous-output derivation path accepted")
	}
	parent.Scriptpubkey = e.wire.Bitcoin.Script

	b.BitcoinCoins = append(b.BitcoinCoins, MigrationCoin{TxID: e.wire.Bitcoin.Coin.TxID, Vout: 1, Value: "10000", Branch: 0, Index: 0})
	if e.c.checkBitcoin(testContext, b, attempts, b.BitcoinCoins).State == "confirmed" {
		t.Fatal("partial snapshot activated")
	}
	key, _ := h.TargetPolicy.HederaKey()
	e.hedera.account.Key.Key = key
	attempts = append(attempts, MigrationAttempt{IntentID: h.ID, TxID: "0.0.9001@1.000000000", Memo: "reviewed", MaxFee: "100000000"})
	e.hedera.receipts[attempts[1].TxID] = &hedera.NativeReceipt{Found: true, TransactionID: attempts[1].TxID, Result: "SUCCESS", IntentMemo: "wrong", FeeTinybars: "1000", Timestamp: e.hedera.account.Balance.Timestamp}
	if e.c.checkHedera(testContext, h, attempts[1:]).State == "confirmed" {
		t.Fatal("wrong operation accepted")
	}
	e.hedera.receipts[attempts[1].TxID].IntentMemo = "reviewed"
	if e.c.checkHedera(testContext, h, attempts[1:]).State != "confirmed" {
		t.Fatal("exact new key and receipt rejected")
	}
	_, err := e.c.repo.Update(testContext, m.Manifest.ID, m.Revision, func(current *Migration) error { current.Attempts = attempts; return nil })
	if err != nil {
		t.Fatal(err)
	}
	completed, err := e.c.Check(testContext, e.actors[0], m.Manifest.ID)
	if err != nil || completed.Status != "complete" || completed.CompletedAt == nil {
		t.Fatal("both chains did not activate", err)
	}
	e.btc.offline = true
	monitored, err := e.c.Check(testContext, e.actors[0], m.Manifest.ID)
	if err != nil || monitored.Status != "complete" || monitored.MonitoringWarning == "" {
		t.Fatal("outage silently refroze activated group", err)
	}
}
func TestRevisedMigrationRequiresFreshBothGroupConfirmations(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.freeze(t, e.draft(t))
	changes := []IntentReview{}
	for _, i := range m.Manifest.Intents {
		change := IntentReview{IntentID: i.ID, MaxFee: i.MaxFee}
		if i.Chain == "bitcoin" {
			change.BitcoinCoins = []MigrationCoin{}
		}
		changes = append(changes, change)
	}
	revised, err := e.c.Review(testContext, e.actors[1], m.Manifest.ID, changes)
	if err != nil {
		t.Fatal(err)
	}
	if !revised.ReviewPending || revised.Digest == m.Digest || len(revised.ReviewHistory) != 1 || len(revised.Approvals) != 0 {
		t.Fatal("amendment retained old approvals")
	}
	if _, err = e.c.Approve(testContext, e.actors[0], m.Manifest.ID, "source", signDevice(t, e.keys[0], ApprovalMessage(m, "source"))); err == nil {
		t.Fatal("old review signature approved new scope")
	}
	revised = e.freeze(t, revised)
	if revised.ReviewPending || revised.Status != "frozen" {
		t.Fatal("revised review did not freeze")
	}
}

func TestHederaRegisteredAttemptValidatesExactNativeBody(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.draft(t)
	m.Manifest.ID = e.wire.MigrationID
	m.Digest = Hash(ManifestFields(m.Manifest))
	repo, err := NewMigrationRepository(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	e.c.repo = repo
	if err = repo.Create(testContext, m); err != nil {
		t.Fatal(err)
	}
	m = e.freeze(t, m)
	var intent MigrationIntent
	for _, i := range m.Manifest.Intents {
		if i.Chain == "hedera" {
			intent = i
		}
	}
	var p nativeProposal
	_ = json.Unmarshal(e.wire.Hedera.Source, &p)
	registered, err := e.c.Register(testContext, e.actors[0], m.Manifest.ID, RegisterInput{IntentID: intent.ID, TxID: p.TransactionID, SourceProposal: e.wire.Hedera.Source, TargetProposal: e.wire.Hedera.Target})
	if err != nil {
		t.Fatal(err)
	}
	if len(registered.Attempts) != 1 || registered.Attempts[0].Memo == "" {
		t.Fatal("exact key update not registered")
	}
	var changed map[string]any
	_ = json.Unmarshal(e.wire.Hedera.Source, &changed)
	changed["privateKey"] = "must-be-rejected"
	raw, _ := json.Marshal(changed)
	if _, _, err = decodeProposal(raw); err == nil {
		t.Fatal("unsupported secret-bearing field accepted")
	}
}
func TestMigrationDeviceAccessAndRepositoryCollision(t *testing.T) {
	e := newMigrationEnv(t)
	m := e.draft(t)
	outsider := &auth.Principal{UserID: uuid.New(), DeviceID: uuid.New()}
	if _, _, err := e.c.access(testContext, outsider, m); err == nil {
		t.Fatal("outsider read migration")
	}
	changed := *e.actors[0]
	changed.DeviceID = uuid.New()
	if _, _, err := e.c.member(testContext, &changed, m.Manifest.SourceWalletID); err == nil {
		t.Fatal("different device impersonated participant")
	}
	if err := e.c.repo.Create(testContext, m); !errors.Is(err, ErrMigrationConflict) {
		t.Fatal("duplicate source migration accepted")
	}
	if _, err := e.c.Approve(testContext, e.actors[0], m.Manifest.ID, "source", signDevice(t, e.keys[1], ApprovalMessage(m, "source"))); err == nil {
		t.Fatal("another device approved as member")
	}
}
