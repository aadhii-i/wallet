package audit

import (
	"testing"
	"time"

	"github.com/qdwallet/wallet-api/internal/store"
)

func mkEntry(id int64, action string) *store.AuditLog {
	return &store.AuditLog{
		ID:          id,
		ActorType:   "user",
		ActorID:     "u-1",
		Action:      action,
		SubjectType: "wallet",
		SubjectID:   "w-1",
		Metadata:    map[string]any{"k": "v"},
		CreatedAt:   time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func chain(t *testing.T, n int) []*store.AuditLog {
	t.Helper()
	var entries []*store.AuditLog
	var prev []byte
	for i := 0; i < n; i++ {
		e := mkEntry(int64(i+1), "action")
		e.PrevHash = prev
		hash, err := RowHash(prev, e)
		if err != nil {
			t.Fatalf("RowHash: %v", err)
		}
		e.RowHash = hash
		entries = append(entries, e)
		prev = hash
	}
	return entries
}

func TestVerifyChainAcceptsIntactChain(t *testing.T) {
	entries := chain(t, 5)
	if err := VerifyChain(entries); err != nil {
		t.Fatalf("expected intact chain to verify, got: %v", err)
	}
}

func TestVerifyChainDetectsTamperedRow(t *testing.T) {
	entries := chain(t, 5)
	entries[2].Action = "tampered-action"
	if err := VerifyChain(entries); err == nil {
		t.Fatal("expected tamper detection error, got nil")
	}
}

func TestVerifyChainDetectsReorderedRow(t *testing.T) {
	entries := chain(t, 4)
	entries[1], entries[2] = entries[2], entries[1]
	if err := VerifyChain(entries); err == nil {
		t.Fatal("expected reorder to be detected, got nil")
	}
}

func TestVerifyChainDetectsDeletedRow(t *testing.T) {
	entries := chain(t, 4)
	entries = append(entries[:1], entries[2:]...)
	if err := VerifyChain(entries); err == nil {
		t.Fatal("expected deletion to be detected, got nil")
	}
}

func TestCanonicalJSONDeterministic(t *testing.T) {
	e := mkEntry(1, "action")
	a, err := CanonicalJSON(e)
	if err != nil {
		t.Fatal(err)
	}
	b, err := CanonicalJSON(e)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatalf("expected deterministic output, got %s vs %s", a, b)
	}
}
