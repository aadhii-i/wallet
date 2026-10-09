package security

import (
	"hash/fnv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is a keyed rate limiter (per session id, per IP, per provider,
// ...). The default implementation is in-process; when REDIS_URL is set a
// future implementation could back it with Redis GCRA, but a single
// wallet-api replica in dev/test never needs that, and the interface keeps
// the door open without adding a hard Redis dependency.
type Limiter interface {
	Allow(key string) bool
}

const (
	numRateLimitShards  = 32
	maxEntriesPerShard  = 2000 // bounds total memory to numShards*maxEntriesPerShard buckets
	rateLimitReapPeriod = time.Minute
)

// KeyedTokenBucket is an in-memory, sharded token-bucket limiter (one bucket
// per key). Sharding means Allow only ever locks one shard's mutex, never a
// single global lock, and idle-entry eviction runs as a periodic background
// sweep per shard rather than an inline O(n) scan under the hot-path lock.
// Each shard is additionally hard-capped at maxEntriesPerShard so total
// memory is bounded even under a sustained high-cardinality-key attack
// (e.g. a botnet cycling through IPs faster than the reaper can catch up).
type KeyedTokenBucket struct {
	shards  [numRateLimitShards]*rateLimitShard
	rate    rate.Limit
	burst   int
	idleTTL time.Duration
	stop    chan struct{}
}

type rateLimitShard struct {
	mu      sync.Mutex
	buckets map[string]*bucketEntry
}

type bucketEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewKeyedTokenBucket creates a limiter allowing `perSecond` events/sec per
// key, with the given burst, and starts its background idle-entry reaper.
func NewKeyedTokenBucket(perSecond float64, burst int) *KeyedTokenBucket {
	k := &KeyedTokenBucket{
		rate:    rate.Limit(perSecond),
		burst:   burst,
		idleTTL: 10 * time.Minute,
		stop:    make(chan struct{}),
	}
	for i := range k.shards {
		k.shards[i] = &rateLimitShard{buckets: make(map[string]*bucketEntry)}
	}
	go k.reapLoop()
	return k
}

// Close stops the background reaper goroutine. Safe to call once; mainly
// useful in tests that create many limiters and want to avoid leaking
// goroutines.
func (k *KeyedTokenBucket) Close() {
	select {
	case <-k.stop:
	default:
		close(k.stop)
	}
}

func (k *KeyedTokenBucket) shardFor(key string) *rateLimitShard {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return k.shards[h.Sum32()%numRateLimitShards]
}

func (k *KeyedTokenBucket) Allow(key string) bool {
	s := k.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	entry, ok := s.buckets[key]
	if !ok {
		if len(s.buckets) >= maxEntriesPerShard {
			// Bound memory under a hot-path lock: evict one arbitrary entry
			// (Go map iteration order is randomized) rather than scanning
			// for the least-recently-used one, which would reintroduce the
			// O(n)-under-lock problem this type exists to avoid. The
			// periodic reapLoop is what actually keeps steady-state size
			// down; this is only a last-resort backstop.
			for kk := range s.buckets {
				delete(s.buckets, kk)
				break
			}
		}
		entry = &bucketEntry{limiter: rate.NewLimiter(k.rate, k.burst)}
		s.buckets[key] = entry
	}
	entry.lastSeen = now
	return entry.limiter.Allow()
}

func (k *KeyedTokenBucket) reapLoop() {
	ticker := time.NewTicker(rateLimitReapPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-k.stop:
			return
		case <-ticker.C:
			k.reapOnce()
		}
	}
}

// reapOnce removes idle entries, one shard at a time, so no single sweep
// ever holds a lock spanning the whole key space.
func (k *KeyedTokenBucket) reapOnce() {
	now := time.Now()
	for _, s := range k.shards {
		s.mu.Lock()
		for key, e := range s.buckets {
			if now.Sub(e.lastSeen) >= k.idleTTL {
				delete(s.buckets, key)
			}
		}
		s.mu.Unlock()
	}
}
