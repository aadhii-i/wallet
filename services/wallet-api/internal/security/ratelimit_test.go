package security

import (
	"fmt"
	"testing"
	"time"
)

func TestKeyedTokenBucketPerKeyIsolation(t *testing.T) {
	k := NewKeyedTokenBucket(1, 1)
	defer k.Close()

	if !k.Allow("a") {
		t.Fatal("expected first request for key a to be allowed")
	}
	if k.Allow("a") {
		t.Fatal("expected second immediate request for key a to be denied (burst exhausted)")
	}
	// A different key must have its own independent bucket.
	if !k.Allow("b") {
		t.Fatal("expected first request for key b to be allowed independently of key a")
	}
}

// TestKeyedTokenBucketBoundedMemory exercises a large number of distinct
// keys and asserts the total number of tracked buckets never exceeds the
// configured cap (numShards * maxEntriesPerShard), i.e. an attacker cycling
// through many source IPs cannot grow the limiter's memory without bound.
func TestKeyedTokenBucketBoundedMemory(t *testing.T) {
	k := NewKeyedTokenBucket(5, 5)
	defer k.Close()

	const n = 500000
	for i := 0; i < n; i++ {
		k.Allow(fmt.Sprintf("key-%d", i))
	}

	total := 0
	for _, s := range k.shards {
		s.mu.Lock()
		total += len(s.buckets)
		s.mu.Unlock()
	}
	max := numRateLimitShards * maxEntriesPerShard
	if total > max {
		t.Fatalf("expected at most %d tracked buckets, got %d", max, total)
	}
}

func TestKeyedTokenBucketReapRemovesIdleEntries(t *testing.T) {
	k := NewKeyedTokenBucket(5, 5)
	defer k.Close()
	k.idleTTL = 0 // treat everything as immediately idle for this test

	k.Allow("stale-key")
	k.reapOnce()

	total := 0
	for _, s := range k.shards {
		s.mu.Lock()
		total += len(s.buckets)
		s.mu.Unlock()
	}
	if total != 0 {
		t.Fatalf("expected the idle entry to be reaped, got %d remaining", total)
	}
}

var _ = time.Second
