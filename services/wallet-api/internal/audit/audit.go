// Package audit implements the append-only, hash-chained audit log
// described in spec §9.6: every row stores prev_hash and
// row_hash = SHA-256(prev_hash || canonical_json(row)). Store implementations
// (memory, postgres) use these pure functions so the hashing logic is
// tested once and identical everywhere.
package audit

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/qdwallet/wallet-api/internal/store"
)

// Record builds an AuditLog row and appends it via logs.Append, which is
// responsible for computing the hash chain. It is the entry point every
// domain package should use to write an audit entry.
func Record(ctx context.Context, logs store.AuditLogs, actorType, actorID, action, subjectType, subjectID string, metadata map[string]any) error {
	entry := &store.AuditLog{
		ActorType:   actorType,
		ActorID:     actorID,
		Action:      action,
		SubjectType: subjectType,
		SubjectID:   subjectID,
		Metadata:    metadata,
		CreatedAt:   time.Now().UTC(),
	}
	return logs.Append(ctx, entry)
}

// canonicalRow is the subset of an AuditLog row that is hashed. It excludes
// PrevHash/RowHash/ID themselves (which are either inputs to, or outputs of,
// the hash) but includes everything else, with map keys sorted for
// determinism.
type canonicalRow struct {
	ActorType   string         `json:"actor_type"`
	ActorID     string         `json:"actor_id"`
	Action      string         `json:"action"`
	SubjectType string         `json:"subject_type"`
	SubjectID   string         `json:"subject_id"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	CreatedAt   string         `json:"created_at"`
}

// CanonicalJSON produces a deterministic JSON encoding of the row's
// hash-relevant fields.
func CanonicalJSON(e *store.AuditLog) ([]byte, error) {
	sortedMeta := sortedMap(e.Metadata)
	row := canonicalRow{
		ActorType:   e.ActorType,
		ActorID:     e.ActorID,
		Action:      e.Action,
		SubjectType: e.SubjectType,
		SubjectID:   e.SubjectID,
		Metadata:    sortedMeta,
		CreatedAt:   e.CreatedAt.UTC().Format("2006-01-02T15:04:05.000000000Z"),
	}
	return json.Marshal(row)
}

// sortedMap returns a copy of m; Go's encoding/json already sorts map keys
// when marshalling, so this exists mainly for documentation/clarity and to
// give us a hook if we need custom ordering later.
func sortedMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]any, len(m))
	for _, k := range keys {
		out[k] = m[k]
	}
	return out
}

// RowHash computes SHA-256(prevHash || canonicalJSON(entry)).
func RowHash(prevHash []byte, entry *store.AuditLog) ([]byte, error) {
	body, err := CanonicalJSON(entry)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write(prevHash)
	h.Write(body)
	return h.Sum(nil), nil
}

// VerifyChain recomputes every row's hash in order and confirms it matches
// the stored RowHash and that PrevHash matches the previous row's RowHash
// (or is empty for the first row).
func VerifyChain(entries []*store.AuditLog) error {
	var prevHash []byte
	for i, e := range entries {
		if string(e.PrevHash) != string(prevHash) {
			return fmt.Errorf("audit: row %d (id=%d) has prev_hash mismatch", i, e.ID)
		}
		want, err := RowHash(prevHash, e)
		if err != nil {
			return fmt.Errorf("audit: row %d (id=%d) hash computation failed: %w", i, e.ID, err)
		}
		if string(want) != string(e.RowHash) {
			return fmt.Errorf("audit: row %d (id=%d) row_hash mismatch: tamper detected", i, e.ID)
		}
		prevHash = e.RowHash
	}
	return nil
}
