// Package indexer records blockchain value transfers for the addresses the
// API knows — personal wallet addresses and shared QdAccount addresses — from
// receipts and logs, without an external indexing service.
//
// Discovery, per address and chain, from a persisted cursor:
//
//   - native ETH, incoming or outgoing, including ETH a contract sends
//     (internal transfers, e.g. a shared account paying a personal wallet):
//     the address's historical balance and nonce are bisected — a block range
//     whose endpoints agree on both had no activity — and only the blocks
//     where they changed are read;
//   - in such a block: transactions from/to the address, and QdAccount
//     Executed events whose recipient is the address (the outer transaction
//     goes relayer → QdAccount; only the event says who received the value);
//   - ERC-20 transfers: eth_getLogs on the Transfer topic with the address
//     as indexed from/to (token transfers do not change the ETH balance);
//   - shared accounts: their own Executed logs (an execution whose inner
//     call failed moves no ETH) and the relayer's recorded execution
//     transactions (an outer revert emits nothing).
//
// Every record is built from the mined receipt: Executed events are taken
// from receipt logs and accepted only from contracts proven to be QdAccounts
// of this deployment's factory. Records are keyed by (chain, tx hash, log
// index), so re-indexing never duplicates. It only reads the chain.
package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/store"
)

type Caller interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
}

const erc20TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// eip7708System emits an ERC-20-shaped Transfer log for every native ETH
// transfer (including internal ones) on chains with EIP-7708 (Sepolia since
// Amsterdam). Those logs are native ETH, never a token.
const eip7708System = "0xfffffffffffffffffffffffffffffffffffffffe"

type Indexer struct {
	store  store.Store
	chains func(chainID int64) (Caller, bool)
	logger *slog.Logger
	now    func() time.Time
	// ChainIDs to index.
	ChainIDs []int64
	Interval time.Duration
	// Backfill: blocks before the first scan of an address that are searched.
	Backfill      uint64
	Confirmations uint64
	// NoDepthChains are scanned to the head (local chains that never reorg).
	NoDepthChains map[int64]bool
	MaxRange      uint64 // blocks per address per pass
	StepBlocks    uint64 // blocks per step; the cursor is saved after each step
	MaxCalls      int    // RPC calls per address per pass for bisection
	LogChunk      uint64 // eth_getLogs block range to try first (halved on provider range errors)
	// LogWindow bounds wide eth_getLogs scans to the newest blocks when the
	// provider has been seen to cap log ranges (below LogChunk): token
	// transfers and failed-call executions (the only things found only through
	// logs) are searched from LogWindow blocks before an address's first
	// indexing onward. Native ETH history comes from balance bisection and
	// covers the whole backfill. Providers cap log ranges (Alchemy's free tier:
	// 10 blocks), so scanning logs over a 50,000-block backfill would take
	// thousands of calls.
	LogWindow uint64
	// FullLogChains are scanned with eth_getLogs over the whole range (local
	// chains, whose RPC does not cap log ranges).
	FullLogChains map[int64]bool

	locks  sync.Map // "chain/address" → *sync.Mutex
	mu     sync.Mutex
	qdAcct map[string]bool // "chain/address" → proven QdAccount (or not)
	// logRange: the eth_getLogs range each chain's provider accepted (learned once).
	logRange map[int64]uint64
	warned   map[string]string
}

func New(st store.Store, chains func(int64) (Caller, bool), logger *slog.Logger) *Indexer {
	if logger == nil {
		logger = slog.Default()
	}
	return &Indexer{
		store: st, chains: chains, logger: logger, now: time.Now,
		Interval: 10 * time.Second, Backfill: 50_000, Confirmations: 2, NoDepthChains: map[int64]bool{31337: true},
		MaxRange: 25_000, StepBlocks: 2_000, MaxCalls: 400, LogChunk: 2_000, LogWindow: 200, FullLogChains: map[int64]bool{31337: true},
		qdAcct: map[string]bool{}, warned: map[string]string{}, logRange: map[int64]uint64{},
	}
}

// Run indexes every chain in its own loop: chains have separate provider
// quotas, so a long catch-up on one (after downtime, under a provider's
// log-range cap and the background rate limit) never delays the others.
func (ix *Indexer) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, id := range ix.ChainIDs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t := time.NewTicker(ix.Interval)
			defer t.Stop()
			for {
				ix.TickChain(ctx, id)
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}
	wg.Wait()
}

// Tick runs one pass over every watched address on every chain.
func (ix *Indexer) Tick(ctx context.Context) {
	for _, id := range ix.ChainIDs {
		ix.TickChain(ctx, id)
	}
}

// TickChain runs one pass over every watched address on one chain.
func (ix *Indexer) TickChain(ctx context.Context, id int64) {
	watched, err := ix.store.ChainIndex().WatchedAddresses(ctx)
	if err != nil {
		ix.warn("watch", "chain index: listing addresses failed", err)
		return
	}
	for _, w := range watched {
		if ctx.Err() != nil {
			return
		}
		// One step per address per round: addresses take turns, so a long
		// catch-up on one never holds back the others (a shared account's
		// fresh executions are recorded at the start of its every pass).
		if err := ix.syncAddress(ctx, id, w.Address, w.Kind == "shared", false, ix.roundRange()); err != nil && !errors.Is(err, ErrIndexing) {
			ix.warn(fmt.Sprintf("%d/%s", id, w.Address), "chain index pass failed", err)
		}
	}
}

// Sync indexes the given addresses on one chain now (e.g. when a user opens
// Activity). An address already being indexed is skipped, not waited for.
func (ix *Indexer) Sync(ctx context.Context, chainID int64, addresses []string, shared bool) error {
	if _, ok := ix.chains(chainID); !ok {
		return fmt.Errorf("%w: chain %d", ErrNoRPC, chainID)
	}
	var errs []error
	for _, a := range addresses {
		if err := ix.syncAddress(ctx, chainID, strings.ToLower(a), shared, true, ix.MaxRange); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (ix *Indexer) warn(key, msg string, err error) {
	text := sanitize(err.Error())
	ix.mu.Lock()
	dup := ix.warned[key] == text
	ix.warned[key] = text
	ix.mu.Unlock()
	if !dup {
		ix.logger.Warn(msg, "key", key, "err", text)
	}
}

func (ix *Indexer) lock(chainID int64, addr string, try bool) (func(), bool) {
	v, _ := ix.locks.LoadOrStore(fmt.Sprintf("%d/%s", chainID, addr), &sync.Mutex{})
	m := v.(*sync.Mutex)
	if try {
		if !m.TryLock() {
			return nil, false
		}
	} else {
		m.Lock()
	}
	return m.Unlock, true
}

type acctState struct {
	bal   *big.Int
	nonce uint64
}

func (a acctState) eq(b acctState) bool { return a.nonce == b.nonce && a.bal.Cmp(b.bal) == 0 }

var errBudget = errors.New("index pass exceeded its RPC budget")

// pass holds per-pass caches.
type pass struct {
	ix      *Indexer
	ctx     context.Context
	chain   Caller
	chainID int64
	addr    string
	shared  bool
	times   map[uint64]time.Time
	done    map[string]bool // tx hashes already recorded this pass
	// firstIndexed: the head when this address was first indexed (the log window's end).
	firstIndexed uint64
}

// windowStart is the first block wide log scans cover: everything on chains
// whose provider accepts wide ranges, the newest LogWindow blocks before the
// first indexing once the provider has been seen to cap log ranges.
func (p *pass) windowStart() uint64 {
	ix := p.ix
	ix.mu.Lock()
	learned, capped := ix.logRange[p.chainID]
	ix.mu.Unlock()
	if !capped || learned >= ix.LogChunk || ix.FullLogChains[p.chainID] || ix.LogWindow == 0 || p.firstIndexed <= ix.LogWindow {
		return 0
	}
	return p.firstIndexed - ix.LogWindow
}

// roundRange is how far a background round advances one address.
func (ix *Indexer) roundRange() uint64 {
	if ix.StepBlocks > 0 && ix.StepBlocks < ix.MaxRange {
		return ix.StepBlocks
	}
	return ix.MaxRange
}

func (ix *Indexer) syncAddress(ctx context.Context, chainID int64, addr string, shared, try bool, maxRange uint64) error {
	raw, ok := ix.chains(chainID)
	if !ok {
		return nil
	}
	chain := retrying{raw}
	unlock, ok := ix.lock(chainID, addr, try)
	if !ok {
		return ErrIndexing // another pass is indexing this address right now
	}
	defer unlock()

	head, err := quantity(ctx, chain, "eth_blockNumber", []any{})
	if err != nil {
		return err
	}
	latest := head.Uint64()
	if !ix.NoDepthChains[chainID] && latest > ix.Confirmations {
		latest -= ix.Confirmations
	}
	ci := ix.store.ChainIndex()
	cur, err := ci.GetCursor(ctx, chainID, addr)
	if errors.Is(err, store.ErrNotFound) {
		start := uint64(0)
		if latest > ix.Backfill {
			start = latest - ix.Backfill
		}
		cur = &store.IndexCursor{ChainID: chainID, Address: addr, SinceBlock: start + 1, ScannedThrough: start}
	} else if err != nil {
		return err
	}
	if latest <= cur.ScannedThrough {
		return nil
	}
	lo, hi := cur.ScannedThrough, latest
	if hi > lo+maxRange {
		hi = lo + maxRange
	}
	p := &pass{ix: ix, ctx: ctx, chain: chain, chainID: chainID, addr: addr, shared: shared, times: map[uint64]time.Time{}, done: map[string]bool{}}
	p.firstIndexed = cur.SinceBlock + ix.Backfill
	if p.firstIndexed > latest || cur.SinceBlock <= 1 {
		p.firstIndexed = latest
	}
	if shared {
		if err := p.sharedExecutions(); err != nil {
			return err
		}
	}
	// Advance in steps and save the cursor after each: a pass cut short (a
	// request deadline, provider rate limits) keeps the progress it made.
	save := context.WithoutCancel(ctx)
	first := cur.ScannedThrough+1 == cur.SinceBlock
	for lo < hi {
		end := hi
		if ix.StepBlocks > 0 && end > lo+ix.StepBlocks {
			end = lo + ix.StepBlocks
		}
		if err := p.step(lo, end); err != nil {
			if errors.Is(err, errHistoricalState) && first {
				// No archive state: history for this address starts now.
				ix.warn(fmt.Sprintf("%d/%s/archive", chainID, addr), "chain index: historical balances unavailable; indexing from the current block", err)
				cur.SinceBlock, cur.ScannedThrough = latest+1, latest
				return ci.PutCursor(save, cur)
			}
			return err
		}
		first = false
		lo = end
		cur.ScannedThrough, cur.UpdatedAt = end, ix.now()
		if err := ci.PutCursor(save, cur); err != nil {
			return err
		}
	}
	if hi < latest {
		return ErrIndexing // MaxRange reached: the next pass continues
	}
	return nil
}

// step indexes the blocks (lo, hi] for the pass's address.
func (p *pass) step(lo, hi uint64) error {
	if p.shared {
		if err := p.logs(lo+1, hi, []any{qdaccount.ExecutedTopic().Hex()}, p.addr); err != nil {
			return err
		}
	}
	pad := topicFor(p.addr)
	if err := p.logs(lo+1, hi, []any{erc20TransferTopic, pad}, ""); err != nil {
		return err
	}
	if err := p.logs(lo+1, hi, []any{erc20TransferTopic, nil, pad}, ""); err != nil {
		return err
	}
	return p.balanceChanges(lo, hi)
}

var errHistoricalState = errors.New("historical state unavailable")

// IsMissingState reports whether err is a node's answer that it has no state
// for the requested block (not a transient failure).
func IsMissingState(err error) bool { return errors.Is(classifyStateErr(err), errHistoricalState) }

// classifyStateErr marks only a node's genuine "no state for that block"
// answer as errHistoricalState (which makes a first indexing start at the
// head). Timeouts, cancellations, rate limits and network errors are not:
// treating them as missing state would silently skip an address's history.
func classifyStateErr(err error) error {
	m := strings.ToLower(err.Error())
	for _, s := range []string{"missing trie node", "historical state", "state is not available", "state not available", "state at block", "pruned", "archive"} {
		if strings.Contains(m, s) {
			return fmt.Errorf("%w: %v", errHistoricalState, err)
		}
	}
	return err
}

// ErrIndexing: an address is not yet indexed up to the chain head (a pass is
// running for it, or this one stopped early); what is stored is still valid.
var ErrIndexing = errors.New("still indexing")

// ErrNoRPC: the API has no RPC upstream for the chain, so nothing can be indexed.
var ErrNoRPC = errors.New("no RPC configured for this network")

// Sanitize removes RPC URLs (which carry provider API keys) from an error text.
func Sanitize(s string) string { return sanitize(s) }

// balanceChanges bisects (lo, hi] for blocks where the address's balance or
// nonce changed, and records what happened in each.
func (p *pass) balanceChanges(lo, hi uint64) error {
	calls := 0
	state := func(n uint64) (acctState, error) {
		calls += 2
		if calls > p.ix.MaxCalls {
			return acctState{}, errBudget
		}
		tag := hexutil.EncodeUint64(n)
		bal, err := quantity(p.ctx, p.chain, "eth_getBalance", []any{p.addr, tag})
		if err != nil {
			return acctState{}, classifyStateErr(err)
		}
		nonce, err := p.nonceAt(tag)
		if err != nil {
			return acctState{}, classifyStateErr(err)
		}
		return acctState{bal, nonce}, nil
	}
	sLo, err := state(lo)
	if err != nil {
		return err
	}
	sHi, err := state(hi)
	if err != nil {
		return err
	}
	type change struct {
		block         uint64
		before, after acctState
	}
	var changes []change
	var bisect func(a, b uint64, sa, sb acctState) error
	bisect = func(a, b uint64, sa, sb acctState) error {
		if sa.eq(sb) {
			return nil
		}
		if b == a+1 {
			changes = append(changes, change{b, sa, sb})
			return nil
		}
		mid := a + (b-a)/2
		sm, err := state(mid)
		if err != nil {
			return err
		}
		if err := bisect(a, mid, sa, sm); err != nil {
			return err
		}
		return bisect(mid, b, sm, sb)
	}
	if err := bisect(lo, hi, sLo, sHi); err != nil {
		return err
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].block < changes[j].block })
	for _, c := range changes {
		if err := p.block(c.block, new(big.Int).Sub(c.after.bal, c.before.bal)); err != nil {
			return err
		}
	}
	return nil
}

// nonceAt is the second half of an address's state: the transaction count
// for an EOA, and for a shared account its QdAccount execution nonce. A
// contract's transaction count never changes, so receiving X and then sending
// X would leave (balance, count) unchanged and both transfers would be missed;
// a QdAccount's balance only decreases through execute, which always
// increments its execution nonce. Before the account exists it is 0.
func (p *pass) nonceAt(tag string) (uint64, error) {
	if !p.shared {
		n, err := quantity(p.ctx, p.chain, "eth_getTransactionCount", []any{p.addr, tag})
		if err != nil {
			return 0, err
		}
		return n.Uint64(), nil
	}
	data, _ := qdaccount.NonceCalldata()
	raw, err := p.chain.Call(p.ctx, "eth_call", []any{map[string]string{"to": p.addr, "data": hexutil.Encode(data)}, tag})
	if err != nil {
		return 0, err
	}
	var out string
	if err := json.Unmarshal(raw, &out); err != nil {
		return 0, err
	}
	return decBig(out).Uint64(), nil
}

// block records the transactions and incoming QdAccount transfers of one
// block where the address's balance changed by delta, and records any
// increase nothing explains as an internal transfer.
func (p *pass) block(n uint64, delta *big.Int) error {
	raw, err := p.chain.Call(p.ctx, "eth_getBlockByNumber", []any{hexutil.EncodeUint64(n), true})
	if err != nil {
		return err
	}
	var b *struct {
		Timestamp    string `json:"timestamp"`
		Transactions []struct {
			Hash string  `json:"hash"`
			From string  `json:"from"`
			To   *string `json:"to"`
		} `json:"transactions"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return err
	}
	if b == nil {
		return fmt.Errorf("block %d not found", n)
	}
	p.times[n] = time.Unix(int64(decU64(b.Timestamp)), 0).UTC()
	for _, tx := range b.Transactions {
		to := ""
		if tx.To != nil {
			to = strings.ToLower(*tx.To)
		}
		if strings.ToLower(tx.From) == p.addr || to == p.addr {
			if err := p.tx(tx.Hash); err != nil {
				return err
			}
		}
	}
	// Value a QdAccount sent to this address: the outer transaction does not name it.
	logs, err := p.getLogs(n, n, []any{qdaccount.ExecutedTopic().Hex()}, "", false)
	if err != nil {
		return err
	}
	for _, l := range logs {
		ev, err := decodeExecuted(l)
		if err != nil || strings.ToLower(ev.To.Hex()) != p.addr {
			continue
		}
		if err := p.tx(l.TxHash); err != nil {
			return err
		}
	}
	// Whatever the recorded transfers do not explain arrived some other way.
	recs, err := p.ix.store.ChainIndex().ListTransfers(p.ctx, p.chainID, []string{p.addr}, 0)
	if err != nil {
		return err
	}
	explained := new(big.Int)
	for _, r := range recs {
		if r.BlockNumber != n || r.Token != "" || r.Kind == store.TransferInternal {
			continue
		}
		amt, _ := new(big.Int).SetString(r.Amount, 10)
		if amt == nil {
			amt = new(big.Int)
		}
		if r.Success && r.To == p.addr && r.From != p.addr {
			explained.Add(explained, amt)
		}
		if r.Success && r.From == p.addr && r.To != p.addr {
			explained.Sub(explained, amt)
		}
		if r.TxFrom == p.addr && r.LogIndex == store.LogIndexTx && r.FeeWei != "" {
			if fee, ok := new(big.Int).SetString(r.FeeWei, 10); ok {
				explained.Sub(explained, fee)
			}
		}
	}
	if extra := new(big.Int).Sub(delta, explained); extra.Sign() > 0 {
		return p.ix.store.ChainIndex().RecordTransfer(p.ctx, &store.ChainTransfer{
			ChainID: p.chainID, TxHash: fmt.Sprintf("internal:%d:%s", n, p.addr), LogIndex: store.LogIndexInternal, Kind: store.TransferInternal,
			To: p.addr, Amount: extra.String(), Success: true, BlockNumber: n, BlockTime: p.times[n], CreatedAt: p.ix.now(),
		})
	}
	return nil
}

// sharedExecutions records the relayer's execution transactions for this
// shared account (including outer reverts, which emit no event).
func (p *pass) sharedExecutions() error {
	execs, err := p.ix.store.SharedWallets().ListExecutions(p.ctx, []store.ExecutionStatus{store.ExecSubmitted, store.ExecConfirmed, store.ExecFailed})
	if err != nil {
		return err
	}
	for _, e := range execs {
		if e.ChainID == p.chainID && strings.EqualFold(e.AccountAddress, p.addr) && e.TxHash != "" {
			if err := p.tx(e.TxHash); err != nil {
				return err
			}
		}
	}
	return nil
}

// logs discovers transactions through eth_getLogs over (from..to) and records them.
func (p *pass) logs(from, to uint64, topics []any, address string) error {
	ls, err := p.getLogs(from, to, topics, address, true)
	if err != nil {
		return err
	}
	for _, l := range ls {
		if err := p.tx(l.TxHash); err != nil {
			return err
		}
	}
	return nil
}

type rawLog struct {
	Address  string   `json:"address"`
	Topics   []string `json:"topics"`
	Data     string   `json:"data"`
	TxHash   string   `json:"transactionHash"`
	LogIndex string   `json:"logIndex"`
}

// getLogs queries logs over [from, to] in provider-sized chunks. A windowed
// (wide) scan skips blocks before windowStart, re-evaluated as the provider's
// range cap is learned.
func (p *pass) getLogs(from, to uint64, topics []any, address string, windowed bool) ([]rawLog, error) {
	var out []rawLog
	p.ix.mu.Lock()
	chunk, learned := p.ix.logRange[p.chainID]
	p.ix.mu.Unlock()
	if !learned {
		chunk = p.ix.LogChunk
	}
	for start := from; start <= to; {
		if windowed {
			if w := p.windowStart(); start < w {
				start = w
				if start > to {
					break
				}
			}
		}
		end := start + chunk - 1
		if end > to {
			end = to
		}
		filter := map[string]any{"fromBlock": hexutil.EncodeUint64(start), "toBlock": hexutil.EncodeUint64(end), "topics": topics}
		if address != "" {
			filter["address"] = address
		}
		raw, err := p.chain.Call(p.ctx, "eth_getLogs", []any{filter})
		if err != nil {
			if chunk > 1 && !isRateLimit(err) { // providers cap the range: shrink, retry, remember
				if n := statedRange(err); n > 0 && n < chunk {
					chunk = n // the provider said how many blocks it accepts
				} else {
					chunk /= 2
				}
				p.ix.mu.Lock()
				p.ix.logRange[p.chainID] = chunk
				p.ix.mu.Unlock()
				continue
			}
			return nil, err
		}
		var ls []rawLog
		if err := json.Unmarshal(raw, &ls); err != nil {
			return nil, err
		}
		out = append(out, ls...)
		start = end + 1
	}
	return out, nil
}

// tx records what a mined transaction did for this address, from its receipt.
func (p *pass) tx(hash string) error {
	hash = strings.ToLower(hash)
	if p.done[hash] {
		return nil
	}
	rawTx, err := p.chain.Call(p.ctx, "eth_getTransactionByHash", []any{hash})
	if err != nil {
		return err
	}
	var tx *struct {
		From  string  `json:"from"`
		To    *string `json:"to"`
		Value string  `json:"value"`
	}
	if err := json.Unmarshal(rawTx, &tx); err != nil {
		return err
	}
	rawRc, err := p.chain.Call(p.ctx, "eth_getTransactionReceipt", []any{hash})
	if err != nil {
		return err
	}
	var rc *struct {
		Status            string   `json:"status"`
		BlockNumber       string   `json:"blockNumber"`
		GasUsed           string   `json:"gasUsed"`
		EffectiveGasPrice string   `json:"effectiveGasPrice"`
		ContractAddress   string   `json:"contractAddress"`
		Logs              []rawLog `json:"logs"`
	}
	if err := json.Unmarshal(rawRc, &rc); err != nil {
		return err
	}
	if tx == nil || rc == nil {
		return nil // not mined (yet)
	}
	p.done[hash] = true
	block := decU64(rc.BlockNumber)
	when, err := p.blockTime(block)
	if err != nil {
		return err
	}
	ok := rc.Status == "0x1"
	gas, price := decU64(rc.GasUsed), decBig(rc.EffectiveGasPrice)
	txFrom := strings.ToLower(tx.From)
	txTo := ""
	if tx.To != nil {
		txTo = strings.ToLower(*tx.To)
	} else {
		txTo = strings.ToLower(rc.ContractAddress)
	}
	base := store.ChainTransfer{
		ChainID: p.chainID, TxHash: hash, TxFrom: txFrom, TxTo: txTo, BlockNumber: block, BlockTime: when,
		GasUsed: gas, GasPriceWei: price.String(), FeeWei: new(big.Int).Mul(new(big.Int).SetUint64(gas), price).String(), CreatedAt: p.ix.now(),
	}
	ci := p.ix.store.ChainIndex()
	value := decBig(tx.Value)
	// The transaction's own transfer: whenever it moved (or tried to move)
	// value, the address sent it, or it was a failed call to the address.
	if value.Sign() > 0 || txFrom == p.addr || (!ok && txTo == p.addr) {
		t := base
		t.LogIndex, t.Kind, t.From, t.To, t.Amount, t.Success = store.LogIndexTx, store.TransferNative, txFrom, txTo, value.String(), ok
		if err := ci.RecordTransfer(p.ctx, &t); err != nil {
			return err
		}
	}
	if !ok {
		return nil // a reverted transaction emits no logs and moves nothing
	}
	type move struct{ from, to, amount string }
	covered := map[move]int{} // native moves already recorded from the tx value or Executed events
	if value.Sign() > 0 {
		covered[move{txFrom, txTo, value.String()}]++
	}
	var native7708 []rawLog
	for _, l := range rc.Logs {
		if len(l.Topics) == 0 {
			continue
		}
		emitter := strings.ToLower(l.Address)
		switch strings.ToLower(l.Topics[0]) {
		case strings.ToLower(qdaccount.ExecutedTopic().Hex()):
			ev, err := decodeExecuted(l)
			if err != nil {
				continue
			}
			to := strings.ToLower(ev.To.Hex())
			if emitter != p.addr && to != p.addr {
				continue
			}
			if genuine, err := p.ix.isQdAccount(p.ctx, p.chain, p.chainID, emitter); err != nil {
				return err
			} else if !genuine {
				continue // an Executed-looking event from some other contract proves nothing
			}
			t := base
			t.LogIndex, t.Kind, t.From, t.To, t.Amount, t.Success = int64(decU64(l.LogIndex)), store.TransferQdExecute, emitter, to, ev.Value.String(), ev.Success
			if err := ci.RecordTransfer(p.ctx, &t); err != nil {
				return err
			}
			if ev.Success && ev.Value.Sign() > 0 {
				covered[move{emitter, to, ev.Value.String()}]++
			}
		case erc20TransferTopic:
			if len(l.Topics) != 3 {
				continue // ERC-721 has 4 topics
			}
			if emitter == eip7708System {
				native7708 = append(native7708, l)
				continue
			}
			from, to := topicAddr(l.Topics[1]), topicAddr(l.Topics[2])
			if from != p.addr && to != p.addr {
				continue
			}
			t := base
			t.LogIndex, t.Kind, t.From, t.To, t.Token, t.Amount, t.Success = int64(decU64(l.LogIndex)), store.TransferERC20, from, to, emitter, decBig(l.Data).String(), true
			if err := ci.RecordTransfer(p.ctx, &t); err != nil {
				return err
			}
		}
	}
	// EIP-7708 native transfer logs: those not already recorded (from the
	// transaction's value or a decoded Executed event) are internal ETH
	// transfers with an exact transaction hash and log index.
	for _, l := range native7708 {
		m := move{topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), decBig(l.Data).String()}
		if m.from != p.addr && m.to != p.addr {
			continue
		}
		if covered[m] > 0 {
			covered[m]--
			continue
		}
		t := base
		t.LogIndex, t.Kind, t.From, t.To, t.Amount, t.Success = int64(decU64(l.LogIndex)), store.TransferNative, m.from, m.to, m.amount, true
		if err := ci.RecordTransfer(p.ctx, &t); err != nil {
			return err
		}
	}
	return nil
}

func (p *pass) blockTime(n uint64) (time.Time, error) {
	if t, ok := p.times[n]; ok {
		return t, nil
	}
	raw, err := p.chain.Call(p.ctx, "eth_getBlockByNumber", []any{hexutil.EncodeUint64(n), false})
	if err != nil {
		return time.Time{}, err
	}
	var b *struct {
		Timestamp string `json:"timestamp"`
	}
	if err := json.Unmarshal(raw, &b); err != nil || b == nil {
		return time.Time{}, fmt.Errorf("block %d not found", n)
	}
	t := time.Unix(int64(decU64(b.Timestamp)), 0).UTC()
	p.times[n] = t
	return t, nil
}

// isQdAccount proves addr is a QdAccount of this deployment: bound to the
// deterministic verifier, at the factory's CREATE2 address for its own key hash.
func (ix *Indexer) isQdAccount(ctx context.Context, chain Caller, chainID int64, addr string) (bool, error) {
	key := fmt.Sprintf("%d/%s", chainID, addr)
	ix.mu.Lock()
	v, ok := ix.qdAcct[key]
	ix.mu.Unlock()
	if ok {
		return v, nil
	}
	call := func(to string, data []byte) ([]byte, error) {
		raw, err := chain.Call(ctx, "eth_call", []any{map[string]string{"to": to, "data": hexutil.Encode(data)}, "latest"})
		if err != nil {
			return nil, err
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		return hexutil.Decode(s)
	}
	genuine := false
	vd, _ := qdaccount.AccountVerifierCalldata()
	if out, err := call(addr, vd); err == nil && len(out) == 32 && common.BytesToAddress(out) == qdaccount.VerifierAddress() {
		hd, _ := qdaccount.AccountPublicKeyHashCalldata()
		if h, err := call(addr, hd); err == nil && len(h) == 32 {
			fd, _ := qdaccount.FactoryAccountAddressCalldata([32]byte(h))
			if a, err := call(qdaccount.FactoryAddress().Hex(), fd); err == nil && len(a) == 32 {
				genuine = strings.EqualFold(common.BytesToAddress(a).Hex(), addr)
			} else if err != nil {
				return false, err
			}
		}
	}
	ix.mu.Lock()
	ix.qdAcct[key] = genuine
	ix.mu.Unlock()
	return genuine, nil
}

func decodeExecuted(l rawLog) (*qdaccount.ExecutedEvent, error) {
	topics := make([]common.Hash, len(l.Topics))
	for i, t := range l.Topics {
		topics[i] = common.HexToHash(t)
	}
	return qdaccount.DecodeExecuted(topics, common.FromHex(l.Data))
}

func topicFor(addr string) string {
	return "0x000000000000000000000000" + strings.TrimPrefix(strings.ToLower(addr), "0x")
}

func topicAddr(t string) string {
	t = strings.TrimPrefix(strings.ToLower(t), "0x")
	if len(t) < 40 {
		return ""
	}
	return "0x" + t[len(t)-40:]
}

func quantity(ctx context.Context, c Caller, method string, params []any) (*big.Int, error) {
	raw, err := c.Call(ctx, method, params)
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return hexutil.DecodeBig(s)
}

func decBig(s string) *big.Int {
	if s == "" || s == "0x" {
		return new(big.Int)
	}
	if v, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16); ok {
		return v
	}
	return new(big.Int)
}

func decU64(s string) uint64 {
	v, _ := hexutil.DecodeUint64(s)
	return v
}

// retrying retries calls a provider refused for rate limiting, with backoff
// (free RPC tiers cap requests per second); other errors are returned as is.
type retrying struct{ c Caller }

func (r retrying) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	wait := 500 * time.Millisecond
	for attempt := 0; ; attempt++ {
		out, err := r.c.Call(ctx, method, params)
		if err == nil || !isRateLimit(err) || attempt == 5 {
			return out, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		wait *= 2
	}
}

var rangeRE = regexp.MustCompile(`(?i)(\d+)[ -]block range|block range (?:of |limit (?:is |of )?)?(\d+)|max(?:imum)? range (?:of |is )?(\d+)`)

// statedRange extracts the block range a provider says it accepts
// ("up to a 10 block range", "block range limit 2000"), or 0.
func statedRange(err error) uint64 {
	m := rangeRE.FindStringSubmatch(err.Error())
	for _, g := range m[min(1, len(m)):] {
		if n, e := strconv.ParseUint(g, 10, 64); e == nil && n > 0 {
			return n
		}
	}
	return 0
}

func isRateLimit(err error) bool {
	m := strings.ToLower(err.Error())
	for _, s := range []string{"429", "rate limit", "too many requests", "exceeded its compute units", "capacity", "throughput"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// sanitize removes RPC URLs (which carry provider API keys) from errors.
func sanitize(s string) string {
	for _, scheme := range []string{"https://", "http://", "wss://", "ws://"} {
		for {
			i := strings.Index(s, scheme)
			if i < 0 {
				break
			}
			j := i
			for j < len(s) && s[j] != ' ' && s[j] != '"' && s[j] != '\'' {
				j++
			}
			s = s[:i] + "<rpc>" + s[j:]
		}
	}
	return s
}
