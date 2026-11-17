package sharedwallet

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

type timedRPC struct {
	liveRPC
	mu    sync.Mutex
	n     map[string]int
	dur   map[string]time.Duration
	fails map[string]int
}

func (t *timedRPC) Call(ctx context.Context, m string, p any) (json.RawMessage, error) {
	start := time.Now()
	out, err := t.liveRPC.Call(ctx, m, p)
	t.mu.Lock()
	t.n[m]++
	t.dur[m] += time.Since(start)
	if err != nil {
		t.fails[m]++
	}
	t.mu.Unlock()
	return out, err
}

// Diagnostic only (QD_SEPOLIA_PROBE=1): where one indexing step spends its time.
func TestLiveSepoliaIndexStepProbe(t *testing.T) {
	url := os.Getenv("QD_SEPOLIA_RPC")
	if url == "" || os.Getenv("QD_SEPOLIA_PROBE") == "" {
		t.Skip("probe not requested")
	}
	st := memory.New()
	rpc := &timedRPC{liveRPC: liveRPC{url}, n: map[string]int{}, dur: map[string]time.Duration{}, fails: map[string]int{}}
	ix := indexer.New(st, func(id int64) (indexer.Caller, bool) { return rpc, id == sepolia }, nil)
	const account = "0x420f1c166536b54715f70f733354ab8aab0052d9"
	_ = st.ChainIndex().PutCursor(context.Background(), &store.IndexCursor{ChainID: sepolia, Address: account, SinceBlock: 12138300, ScannedThrough: 12138299})
	ix.MaxRange = 2000
	start := time.Now()
	err := ix.Sync(context.Background(), sepolia, []string{account}, true)
	t.Logf("one 2000-block step: %s err=%v", time.Since(start).Round(time.Millisecond), err)
	var ms []string
	for m := range rpc.n {
		ms = append(ms, m)
	}
	sort.Strings(ms)
	for _, m := range ms {
		t.Logf("%-28s calls %3d  failed %3d  total %s", m, rpc.n[m], rpc.fails[m], rpc.dur[m].Round(time.Millisecond))
	}
}
