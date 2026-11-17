package sharedwallet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/qdwallet/wallet-api/internal/store"
)

func eth(n int64) *big.Int { return new(big.Int).Mul(big.NewInt(n), big.NewInt(1e18)) }

// The fake chain quotes base fee 15 and tip 2: fee cap = 3×15 + 2 = 47 wei/gas.
const fakeFeeCap = 47

func TestFormatEtherIsExact(t *testing.T) {
	for in, want := range map[string]string{
		"0": "0", "1": "0.000000000000000001", "7000000000000": "0.000007", "20000000000000000": "0.02",
		"1500000000000000000": "1.5", "-5": "-0.000000000000000005", "123456789012345678901": "123.456789012345678901",
	} {
		v, _ := new(big.Int).SetString(in, 10)
		if got := formatEther(v); got != want {
			t.Errorf("formatEther(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestClassifyHealth(t *testing.T) {
	exec, low := big.NewInt(100), big.NewInt(1000)
	cases := []struct {
		bal, pending int64
		ops          int
		want         string
		short        int64
	}{
		{0, 0, 0, GasInsufficient, 100},     // cannot pay even one execution
		{99, 0, 0, GasInsufficient, 1},      //
		{100, 0, 0, GasLow, 0},              // one execution, below the low threshold
		{1000, 0, 0, GasHealthy, 0},         //
		{500, 600, 1, GasInsufficient, 100}, // pending work needs 600
		{700, 600, 1, GasLow, 0},            // covers pending, not pending + low
		{1600, 600, 1, GasHealthy, 0},       //
	}
	for _, c := range cases {
		h, s := classifyHealth(big.NewInt(c.bal), big.NewInt(c.pending), exec, low, c.ops)
		if h != c.want || s.Int64() != c.short {
			t.Errorf("bal %d pending %d: got %s/%s want %s/%d", c.bal, c.pending, h, s, c.want, c.short)
		}
	}
}

func TestEstimateProposalReportsBothBalancesAndSendsNothing(t *testing.T) {
	re := newRelayerEnv(t)
	key := must(re.svc.GetProposal(ctx, re.owner.p, re.prop.ID)).AccountKey
	est := must(re.r.EstimateProposal(ctx, re.prop, key))
	fullGas := requiredGas(fullSetupSteps(true))
	need := new(big.Int).Mul(new(big.Int).SetUint64(fullGas), big.NewInt(fakeFeeCap))
	if est.CanProceed || len(est.SetupSteps) != 13 || est.GasUnits != fullGas || est.RequiredRelayerWei != need.String() {
		t.Fatalf("unfunded estimate: %+v", est)
	}
	if est.AccountShortfallWei != re.value.String() || est.RelayerShortfallWei != need.String() || *est.RelayerBalanceWei != "0" || *est.AccountBalanceWei != "0" {
		t.Fatalf("shortfalls: account %s relayer %s", est.AccountShortfallWei, est.RelayerShortfallWei)
	}
	if !strings.Contains(est.Blocker, "fund the shared account") {
		t.Fatalf("blocker %q", est.Blocker)
	}
	if est.EstimatedFeeWei != new(big.Int).Mul(new(big.Int).SetUint64(fullGas), big.NewInt(17)).String() || est.GasPriceWei != "17" {
		t.Fatalf("fee: %s at %s", est.EstimatedFeeWei, est.GasPriceWei)
	}
	// Shared account funded, relayer short by exactly 1 wei.
	re.chain.balances[re.chain.account] = eth(1)
	re.chain.balances[re.relay] = new(big.Int).Sub(need, big.NewInt(1))
	est = must(re.r.EstimateProposal(ctx, re.prop, key))
	if est.CanProceed || est.RelayerShortfallWei != "1" || est.AccountShortfallWei != "" || !strings.Contains(est.Blocker, "fund the relayer") {
		t.Fatalf("relayer short: %+v", est)
	}
	re.chain.balances[re.relay] = need
	est = must(re.r.EstimateProposal(ctx, re.prop, key))
	if !est.CanProceed || est.Blocker != "" || est.RelayerShortfallWei != "" {
		t.Fatalf("funded: %+v", est)
	}
	if len(re.chain.sent) != 0 {
		t.Fatal("an estimate must never send a transaction")
	}
	// No gas service account for the chain: reported, not guessed.
	re.r.keys = nil
	est = must(re.r.EstimateProposal(ctx, re.prop, key))
	if est.CanProceed || est.RelayerConfigured || !strings.Contains(est.Blocker, "no gas service account") {
		t.Fatalf("no relayer: %+v", est)
	}
}

func TestRelayerStatusFundingHealth(t *testing.T) {
	re := newRelayerEnv(t) // one pending execution, nothing deployed
	re.r.ChainIDs = []int64{re.prop.ChainID}
	status := func() ChainStatus {
		t.Helper()
		st := re.r.Status(ctx)
		if len(st) != 1 || st[0].gasFunding == nil {
			t.Fatalf("status: %+v", st)
		}
		return st[0]
	}
	pending := new(big.Int).Mul(new(big.Int).SetUint64(requiredGas(fullSetupSteps(true))), big.NewInt(fakeFeeCap))
	cs := status()
	if cs.Health != GasInsufficient || cs.PendingOperations != 1 || cs.PendingRequiredWei != pending.String() || cs.ShortfallWei != pending.String() {
		t.Fatalf("unfunded: %s ops %d pending %s short %s", cs.Health, cs.PendingOperations, cs.PendingRequiredWei, cs.ShortfallWei)
	}
	if cs.HealthMessage != "Gas Service Account cannot cover the estimated execution cost. Fund the account before retrying." || cs.GasPriceWei != "17" || cs.FeeCapWei != "47" {
		t.Fatalf("message/prices: %q %s %s", cs.HealthMessage, cs.GasPriceWei, cs.FeeCapWei)
	}
	re.chain.balances[re.relay] = new(big.Int).Add(pending, big.NewInt(1))
	if cs = status(); cs.Health != GasLow || cs.ShortfallWei != "0" || cs.ExecutionsCovered == nil || *cs.ExecutionsCovered != 0 {
		t.Fatalf("covers pending only: %s %v", cs.Health, cs.ExecutionsCovered)
	}
	re.chain.balances[re.relay] = eth(1)
	if cs = status(); cs.Health != GasHealthy || cs.HealthMessage != "Gas Service Account has sufficient funds." {
		t.Fatalf("funded: %s", cs.Health)
	}
	// A configured low threshold above the balance turns it low.
	re.r.LowBalanceWei[re.prop.ChainID] = eth(2)
	if cs = status(); cs.Health != GasLow || !cs.LowBalanceConfigured || cs.LowBalanceWei != eth(2).String() {
		t.Fatalf("configured threshold: %s %s", cs.Health, cs.LowBalanceWei)
	}
	// Status reads only.
	if len(re.chain.sent) != 0 {
		t.Fatal("status sent a transaction")
	}
	b, _ := json.Marshal(cs)
	if strings.Contains(strings.ToLower(string(b)), "private") {
		t.Fatal("status mentions key material")
	}
}

func TestGasMonitorRecordsRelayerPaymentsLinkedToProposal(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	if ex := re.run(100); ex.Status != store.ExecConfirmed {
		t.Fatalf("not confirmed: %s", ex.LastError)
	}
	m := NewGasMonitor(re.r)
	self := strings.ToLower(re.relay.Hex())
	if _, err := m.recordExecutions(ctx, re.chain, re.prop.ChainID, self); err != nil {
		t.Fatal(err)
	}
	hist := must(re.r.History(ctx, re.prop.ChainID, 0))
	if len(hist.Transfers) != 14 {
		t.Fatalf("recorded %d transfers", len(hist.Transfers))
	}
	kinds := map[string]int{}
	for _, tr := range hist.Transfers {
		kinds[tr.Kind]++
		if tr.Direction != store.GasOut || tr.ProposalID == nil || *tr.ProposalID != re.prop.ID || !tr.Success || tr.GasPriceWei != "17" {
			t.Fatalf("transfer: %+v", tr)
		}
		if fee := new(big.Int).Mul(new(big.Int).SetUint64(tr.GasUsed), big.NewInt(17)); tr.FeeWei != fee.String() {
			t.Fatalf("fee %s != %s", tr.FeeWei, fee)
		}
	}
	if kinds[store.GasKindSetup] != 13 || kinds[store.GasKindExecute] != 1 {
		t.Fatalf("kinds %v", kinds)
	}
	// Idempotent.
	if _, err := m.recordExecutions(ctx, re.chain, re.prop.ChainID, self); err != nil {
		t.Fatal(err)
	}
	if n := len(must(re.r.History(ctx, re.prop.ChainID, 0)).Transfers); n != 14 {
		t.Fatalf("re-recorded: %d", n)
	}
}

// histChain: a chain with historical state for one address, for the
// recharge scanner.
type histChain struct {
	self      common.Address
	head      uint64
	txs       map[uint64][]histTx
	internal  map[uint64]int64 // balance credited without a transaction
	noArchive bool
	calls     map[string]int
}

type histTx struct {
	hash, from, to string
	value, fee     int64
	ok             bool
}

func (h *histChain) state(n uint64) (bal int64, nonce uint64) {
	self := strings.ToLower(h.self.Hex())
	for b := uint64(0); b <= n; b++ {
		bal += h.internal[b]
		for _, tx := range h.txs[b] {
			if tx.from == self {
				nonce++
				bal -= tx.fee
				if tx.ok {
					bal -= tx.value
				}
			}
			if tx.to == self && tx.ok {
				bal += tx.value
			}
		}
	}
	return
}

func (h *histChain) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	h.calls[method]++
	p, _ := params.([]any)
	j := func(v any) (json.RawMessage, error) { b, err := json.Marshal(v); return b, err }
	block := func(i int) (uint64, error) {
		n, err := hexutil.DecodeUint64(p[i].(string))
		if err == nil && h.noArchive && n+128 < h.head {
			return 0, errors.New("missing trie node (historical state unavailable)")
		}
		return n, err
	}
	switch method {
	case "eth_blockNumber":
		return j(q(h.head))
	case "eth_getBalance", "eth_getTransactionCount":
		n, err := block(1)
		if err != nil {
			return nil, err
		}
		bal, nonce := h.state(n)
		if method == "eth_getBalance" {
			return j(hexutil.EncodeBig(big.NewInt(bal)))
		}
		return j(q(nonce))
	case "eth_getBlockByNumber":
		n, _ := hexutil.DecodeUint64(p[0].(string))
		var txs []map[string]any
		for _, tx := range h.txs[n] {
			txs = append(txs, map[string]any{"hash": tx.hash, "from": tx.from, "to": tx.to, "value": hexutil.EncodeBig(big.NewInt(tx.value))})
		}
		// Unrelated traffic in the same block.
		txs = append(txs, map[string]any{"hash": fmt.Sprintf("0x%064x", n), "from": "0x00000000000000000000000000000000000000aa", "to": "0x00000000000000000000000000000000000000bb", "value": "0x1"})
		return j(map[string]any{"number": q(n), "timestamp": q(1_800_000_000 + n*12), "transactions": txs})
	case "eth_getTransactionReceipt":
		for b, txs := range h.txs {
			for _, tx := range txs {
				if tx.hash == p[0].(string) {
					status := "0x1"
					if !tx.ok {
						status = "0x0"
					}
					return j(map[string]any{"status": status, "blockNumber": q(b), "gasUsed": q(uint64(tx.fee / 17)), "effectiveGasPrice": q(17), "from": tx.from, "to": tx.to})
				}
			}
		}
		return j(nil)
	}
	return nil, fmt.Errorf("histChain: unsupported %s", method)
}

func TestGasMonitorFindsRechargesByBisection(t *testing.T) {
	re := newRelayerEnv(t)
	self := strings.ToLower(re.relay.Hex())
	funder, other := "0x00000000000000000000000000000000000f00d1", "0x00000000000000000000000000000000000c0de1"
	h := &histChain{self: re.relay, head: 10_002, calls: map[string]int{}, internal: map[uint64]int64{6_000: 5_000}, txs: map[uint64][]histTx{
		3_000: {{hash: "0x" + strings.Repeat("a", 64), from: funder, to: self, value: 50_000_000, ok: true}},
		4_000: {{hash: "0x" + strings.Repeat("b", 64), from: funder, to: self, value: 999, ok: false}}, // reverted: nothing received
		8_000: {{hash: "0x" + strings.Repeat("c", 64), from: self, to: other, value: 0, fee: 17 * 21_000, ok: true}},
	}}
	re.r.chains = func(id int64) (ChainCaller, bool) { return h, id == re.prop.ChainID }
	m := NewGasMonitor(re.r)
	m.NoDepthChains = nil // exercise the confirmation depth
	m.Backfill = 10_000
	m.Tick(ctx)
	through, since := m.coverage(re.prop.ChainID)
	if through == nil || *through != 10_000 || *since != 1 {
		t.Fatalf("coverage %v %v", through, since)
	}
	if h.calls["eth_getBlockByNumber"] > 6 || h.calls["eth_getBalance"] > 120 {
		t.Fatalf("scan was not selective: %v", h.calls)
	}
	byHash := map[string]*store.GasTransfer{}
	for _, tr := range must(re.r.History(ctx, re.prop.ChainID, 0)).Transfers {
		byHash[tr.TxHash] = tr
	}
	if len(byHash) != 3 {
		t.Fatalf("recorded %d: %v", len(byHash), byHash)
	}
	in := byHash["0x"+strings.Repeat("a", 64)]
	if in == nil || in.Direction != store.GasIn || in.Kind != store.GasKindRecharge || in.ValueWei != "50000000" || in.Counterparty != funder || !in.Success || in.BlockNumber != 3_000 {
		t.Fatalf("recharge: %+v", in)
	}
	// A reverted transfer to the account changes neither its balance nor its
	// nonce: it moved no funds and is (correctly) not in the history.
	if bad := byHash["0x"+strings.Repeat("b", 64)]; bad != nil {
		t.Fatalf("reverted recharge recorded: %+v", bad)
	}
	if internal := byHash["internal:6000"]; internal == nil || internal.Kind != store.GasKindRechargeInternal || internal.ValueWei != "5000" {
		t.Fatalf("internal recharge: %+v", internal)
	}
	if out := byHash["0x"+strings.Repeat("c", 64)]; out == nil || out.Direction != store.GasOut || out.Kind != store.GasKindOther || out.FeeWei != fmt.Sprint(17*21_000) || out.ProposalID != nil {
		t.Fatalf("outgoing: %+v", out)
	}

	// Later blocks: only the new range is scanned.
	h.head = 10_102
	h.txs[10_050] = []histTx{{hash: "0x" + strings.Repeat("d", 64), from: funder, to: self, value: 7, ok: true}}
	m.Tick(ctx)
	if through, _ = m.coverage(re.prop.ChainID); *through != 10_100 {
		t.Fatalf("cursor %d", *through)
	}
	if n := len(must(re.r.History(ctx, re.prop.ChainID, 0)).Transfers); n != 4 {
		t.Fatalf("after new recharge: %d", n)
	}
}

func TestGasMonitorWithoutArchiveStartsAtHeadAndBudget(t *testing.T) {
	re := newRelayerEnv(t)
	h := &histChain{self: re.relay, head: 100_000, calls: map[string]int{}, noArchive: true, txs: map[uint64][]histTx{}}
	re.r.chains = func(id int64) (ChainCaller, bool) { return h, id == re.prop.ChainID }
	m := NewGasMonitor(re.r)
	m.NoDepthChains = nil
	m.Tick(ctx)
	if through, since := m.coverage(re.prop.ChainID); through == nil || *through != 99_998 || *since != 99_998 {
		t.Fatalf("non-archive start: %v %v", through, since)
	}
	// A pass that would exceed its RPC budget does not advance the cursor.
	h2 := &histChain{self: re.relay, head: 1_002, calls: map[string]int{}, txs: map[uint64][]histTx{}, internal: map[uint64]int64{}}
	for b := uint64(1); b <= 1_000; b += 10 {
		h2.internal[b] = 1
	}
	re.r.chains = func(id int64) (ChainCaller, bool) { return h2, id == re.prop.ChainID }
	m2 := NewGasMonitor(re.r)
	m2.NoDepthChains = nil
	m2.Backfill, m2.MaxCalls = 1_000, 50
	m2.Tick(ctx)
	if through, _ := m2.coverage(re.prop.ChainID); through != nil {
		t.Fatalf("cursor advanced despite budget: %d", *through)
	}
}
