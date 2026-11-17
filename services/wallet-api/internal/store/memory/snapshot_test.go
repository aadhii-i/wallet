package memory

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

func TestSnapshotRoundTrip(t *testing.T) {
	s := New()
	now := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	uid := uuid.New()
	s.users.data[uid.String()] = &store.User{ID: uid, CreatedAt: now}
	pid, acct, kg := uuid.New(), uuid.New(), uuid.New()
	s.shared.proposals[pid] = &store.Proposal{ID: pid, ChainID: 11155111, ValueWei: "20000000000000000", Digest: []byte{1, 2, 3}, CreatedAt: now}
	s.shared.accountKeys[[2]uuid.UUID{acct, kg}] = &store.AccountKey{AccountID: acct, KeygenID: kg, PublicKey: []byte{9}, Address: "0xabc", CreatedAt: now}
	bn, n := uint64(7), uint64(3)
	next := now.Add(time.Minute)
	s.shared.executions[pid] = &store.Execution{ProposalID: pid, ChainID: 11155111, Status: store.ExecPending, Stage: store.ExecStageSettingUpVerifier,
		SetupTxs: []string{"0x01", "0x02"}, PendingSetupTx: "0x03", SetupAttempts: 1, NextAttemptAt: &next, BlockNumber: &bn, TxNonce: &n,
		RawTx: []byte{0xf8}, CreatedAt: now, UpdatedAt: now}
	s.shared.sids["abcd"] = true

	path := filepath.Join(t.TempDir(), "sub", "store.json")
	h1, err := s.Save(path, [32]byte{})
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot file mode: %v %v", fi.Mode(), err)
	}
	// Unchanged content: same hash, no rewrite needed.
	if h2, _ := s.Save(path, h1); h2 != h1 {
		t.Fatal("hash of unchanged store changed")
	}

	r := New()
	ok, err := r.Load(path)
	if err != nil || !ok {
		t.Fatalf("load: %v %v", ok, err)
	}
	if !reflect.DeepEqual(r.shared.executions[pid], s.shared.executions[pid]) {
		t.Fatalf("execution differs:\n%+v\n%+v", r.shared.executions[pid], s.shared.executions[pid])
	}
	if !reflect.DeepEqual(r.shared.proposals[pid], s.shared.proposals[pid]) || r.users.data[uid.String()] == nil || !r.shared.sids["abcd"] {
		t.Fatal("proposal/user/sid not restored")
	}
	if k := r.shared.accountKeys[[2]uuid.UUID{acct, kg}]; k == nil || k.Address != "0xabc" {
		t.Fatal("account key not restored under its (account, keygen) key")
	}
	// The restored store is usable.
	if _, err := r.SharedWallets().GetExecution(t.Context(), pid); err != nil {
		t.Fatal(err)
	}
	// Missing file: first start.
	if ok, err := New().Load(filepath.Join(t.TempDir(), "none.json")); ok || err != nil {
		t.Fatal("missing snapshot must be a clean first start")
	}
}
