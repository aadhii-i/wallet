package rpc

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common/hexutil"
)

// Live check of the one Sepolia connectivity layer every backend user shares
// (QD_LIVE_SEPOLIA=1, with EVM_RPC_11155111 set as for the API; nothing is
// signed or sent, and no URL or key is printed). QD_LIVE_SEPOLIA_TX: a
// mined transaction hash to verify; QD_LIVE_SEPOLIA_ADDR: an address to read.
func TestLiveSepoliaConnectivity(t *testing.T) {
	if os.Getenv("QD_LIVE_SEPOLIA") != "1" {
		t.Skip("set QD_LIVE_SEPOLIA=1 to run against Sepolia")
	}
	var ups []Upstream
	for i, item := range strings.Split(os.Getenv("EVM_RPC_11155111"), ",") {
		name, url, ok := strings.Cut(strings.TrimSpace(item), "=")
		if !ok {
			name, url = "upstream-"+string(rune('1'+i)), item
		}
		ups = append(ups, Upstream{Name: name, URL: url})
	}
	if len(ups) == 0 || ups[0].URL == "" {
		t.Fatal("EVM_RPC_11155111 is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	p := NewPool(11155111, ups, nil)
	p.SetBackgroundRate(3)

	// Chain id, verified per provider (a wrong-chain provider is never used).
	for _, prov := range p.Providers() {
		if !p.verifyChain(ctx, prov) {
			t.Fatalf("provider %s: chain id is not 11155111 (or unreachable)", prov.Name)
		}
		t.Logf("provider %s: chain id 11155111 verified", prov.Name)
	}
	str := func(method string, params ...any) string {
		t.Helper()
		if params == nil {
			params = []any{}
		}
		out, err := p.Call(ctx, method, params)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		var s string
		if err := json.Unmarshal(out, &s); err != nil {
			t.Fatalf("%s: %s", method, out)
		}
		return s
	}
	head := hexutil.MustDecodeUint64(str("eth_blockNumber"))
	t.Logf("latest block %d", head)

	addr := os.Getenv("QD_LIVE_SEPOLIA_ADDR")
	if addr == "" {
		addr = "0x0000000000000000000000000000000000000000"
	}
	bal := hexutil.MustDecodeBig(str("eth_getBalance", addr, "latest"))
	t.Logf("balance of %s: %s wei", addr, bal)

	// A plain 1-wei transfer to another address (21000; a self-transfer is cheaper).
	gas := hexutil.MustDecodeUint64(str("eth_estimateGas", map[string]string{"from": addr, "to": "0x000000000000000000000000000000000000dEaD", "value": "0x1"}))
	if gas == 0 || gas > 30_000 {
		t.Fatalf("estimateGas for a plain transfer: %d", gas)
	}
	tip := hexutil.MustDecodeBig(str("eth_maxPriorityFeePerGas"))
	t.Logf("estimateGas for a plain transfer: %d; priority fee %s wei", gas, tip)

	if hash := os.Getenv("QD_LIVE_SEPOLIA_TX"); hash != "" {
		out, err := p.Call(ctx, "eth_getTransactionReceipt", []any{hash})
		if err != nil {
			t.Fatal(err)
		}
		var rc struct{ Status, BlockNumber, GasUsed, EffectiveGasPrice, From, To string }
		if err := json.Unmarshal(out, &rc); err != nil || rc.Status != "0x1" {
			t.Fatalf("receipt of %s: %s", hash, out)
		}
		fee := new(big.Int).Mul(hexutil.MustDecodeBig(rc.GasUsed), hexutil.MustDecodeBig(rc.EffectiveGasPrice))
		t.Logf("receipt %s: status 1, block %d, %s -> %s, gas %d, fee %s wei, %d confirmations",
			hash, hexutil.MustDecodeUint64(rc.BlockNumber), rc.From, rc.To, hexutil.MustDecodeUint64(rc.GasUsed), fee, head-hexutil.MustDecodeUint64(rc.BlockNumber))
	}

	// Background work saturating its lane never starves a foreground read.
	var wg sync.WaitGroup
	bg := Background(ctx)
	for i := range 15 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = p.Call(bg, "eth_getBalance", []any{addr, hexutil.EncodeUint64(head - uint64(i) - 5)})
		}()
	}
	start := time.Now()
	str("eth_getTransactionCount", addr, "pending")
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("foreground read waited %s behind background work", el)
	}
	t.Logf("foreground read during a background burst: %s", time.Since(start).Round(time.Millisecond))
	wg.Wait()
}
