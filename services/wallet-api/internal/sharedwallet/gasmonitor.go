package sharedwallet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/store"
)

// GasMonitor records the gas service account's history from chain receipts:
//
//   - outgoing gas payments: every setup and execute transaction the relayer
//     recorded on an execution, linked to its proposal, read from its receipt;
//   - incoming recharges (and any other transaction from the account): found
//     without an indexer by bisecting the account's historical balance and
//     nonce — a block range whose endpoints agree on both has no activity —
//     and reading only the blocks where they change. A balance increase that
//     no transaction in its block explains (e.g. ETH sent by a contract) is
//     recorded as an internal recharge for that block.
//
// It only reads the chain; it never signs or sends anything.
type GasMonitor struct {
	r *Relayer
	// Interval between passes; Backfill is how many blocks before the first
	// pass are searched for history; Confirmations keeps the scan that many
	// blocks behind the head; MaxRange bounds one pass's scanned range and
	// MaxCalls its RPC calls (a pass that exceeds it is retried next time).
	Interval      time.Duration
	Backfill      uint64
	Confirmations uint64
	MaxRange      uint64
	MaxCalls      int
	// NoDepthChains are scanned up to the head: local dev chains (Anvil)
	// mine only on demand and never reorg, so a depth would hide the newest block.
	NoDepthChains map[int64]bool

	mu       sync.Mutex
	cursor   map[int64]uint64 // last block fully scanned, per chain
	since    map[int64]uint64 // first block covered, per chain
	recorded map[string]bool  // "chain/hash" recorded with its proposal link
	warned   map[int64]string
}

func NewGasMonitor(r *Relayer) *GasMonitor {
	m := &GasMonitor{
		r: r, Interval: 12 * time.Second, Backfill: 50_000, Confirmations: 2, MaxRange: 25_000, MaxCalls: 400,
		NoDepthChains: map[int64]bool{31337: true},
		cursor:        map[int64]uint64{}, since: map[int64]uint64{}, recorded: map[string]bool{}, warned: map[int64]string{},
	}
	r.Monitor = m
	return m
}

func (m *GasMonitor) coverage(chainID int64) (through, since *uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cursor[chainID]; ok {
		through = &c
		s := m.since[chainID]
		since = &s
	}
	return
}

func (m *GasMonitor) Run(ctx context.Context) {
	t := time.NewTicker(m.Interval)
	defer t.Stop()
	for {
		m.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick runs one pass over every chain with a gas service account.
func (m *GasMonitor) Tick(ctx context.Context) {
	for id := range m.r.keys {
		if err := m.tickChain(ctx, id); err != nil && ctx.Err() == nil {
			m.warnOnce(id, "gas service history pass failed", err)
		}
	}
}

func (m *GasMonitor) warnOnce(id int64, msg string, err error) {
	text := sanitize(err.Error())
	m.mu.Lock()
	dup := m.warned[id] == text
	m.warned[id] = text
	m.mu.Unlock()
	if !dup {
		m.r.logger.Warn(msg, "chain", id, "err", text)
	}
}

type txLink struct {
	proposal uuid.UUID
	kind     string
}

func (m *GasMonitor) tickChain(ctx context.Context, id int64) error {
	chain, ok := m.r.chains(id)
	if !ok {
		return nil
	}
	addr, _ := m.r.RelayerAddress(id)
	self := strings.ToLower(addr.Hex())
	links, err := m.recordExecutions(ctx, chain, id, self)
	if err != nil {
		return err
	}
	return m.scan(ctx, chain, id, self, links)
}

// recordExecutions records the mined setup/execute transactions of every
// execution this relayer handled on the chain, and returns hash → proposal.
func (m *GasMonitor) recordExecutions(ctx context.Context, chain ChainCaller, id int64, self string) (map[string]txLink, error) {
	execs, err := m.r.store.SharedWallets().ListExecutions(ctx, []store.ExecutionStatus{
		store.ExecPending, store.ExecSubmitting, store.ExecSubmitted, store.ExecConfirmed, store.ExecFailed,
	})
	if err != nil {
		return nil, err
	}
	links := map[string]txLink{}
	for _, e := range execs {
		if e.ChainID != id || !strings.EqualFold(e.RelayerAddress, self) {
			continue
		}
		for _, h := range e.SetupTxs {
			links[strings.ToLower(h)] = txLink{e.ProposalID, store.GasKindSetup}
		}
		if e.PendingSetupTx != "" {
			links[strings.ToLower(e.PendingSetupTx)] = txLink{e.ProposalID, store.GasKindSetup}
		}
		if e.TxHash != "" {
			links[strings.ToLower(e.TxHash)] = txLink{e.ProposalID, store.GasKindExecute}
		}
	}
	for hash, l := range links {
		key := fmt.Sprintf("%d/%s", id, hash)
		m.mu.Lock()
		done := m.recorded[key]
		m.mu.Unlock()
		if done {
			continue
		}
		rc, err := receiptOf(ctx, chain, hash)
		if err != nil {
			return nil, err
		}
		if rc == nil || !strings.EqualFold(rc.From, self) {
			continue // not mined (yet), or dropped and replaced
		}
		t, err := m.outgoing(ctx, chain, id, self, hash, rc, &l)
		if err != nil {
			return nil, err
		}
		if err := m.r.store.SharedWallets().RecordGasTransfer(ctx, t); err != nil {
			return nil, err
		}
		m.mu.Lock()
		m.recorded[key] = true
		m.mu.Unlock()
	}
	return links, nil
}

func (m *GasMonitor) outgoing(ctx context.Context, chain ChainCaller, id int64, self, hash string, rc *rawReceipt, l *txLink) (*store.GasTransfer, error) {
	when, err := m.r.blockTime(ctx, chain, rc.BlockNumber)
	if err != nil {
		return nil, err
	}
	gas, price := decU64(rc.GasUsed), decBig(rc.EffectiveGasPrice)
	to := rc.To
	if to == "" {
		to = rc.ContractAddress
	}
	t := &store.GasTransfer{
		ChainID: id, TxHash: strings.ToLower(hash), Address: self, Direction: store.GasOut, Kind: store.GasKindOther,
		Counterparty: strings.ToLower(to), ValueWei: "0", GasUsed: gas, GasPriceWei: price.String(),
		FeeWei: new(big.Int).Mul(new(big.Int).SetUint64(gas), price).String(), Success: rc.Status == "0x1",
		BlockNumber: decU64(rc.BlockNumber), BlockTime: when, CreatedAt: m.r.now(),
	}
	if l != nil {
		p := l.proposal
		t.ProposalID, t.Kind = &p, l.kind
	}
	return t, nil
}

type acctState struct {
	bal   *big.Int
	nonce uint64
}

func (a acctState) eq(b acctState) bool { return a.nonce == b.nonce && a.bal.Cmp(b.bal) == 0 }

type change struct {
	block         uint64
	before, after acctState
}

var errBudget = errors.New("history scan exceeded its RPC budget for one pass")

func (m *GasMonitor) scan(ctx context.Context, chain ChainCaller, id int64, self string, links map[string]txLink) error {
	head, err := m.r.quantity(ctx, chain, "eth_blockNumber", []any{})
	if err != nil {
		return err
	}
	latest := head.Uint64()
	if conf := m.Confirmations; !m.NoDepthChains[id] && latest > conf {
		latest -= conf
	}
	m.mu.Lock()
	cur, started := m.cursor[id]
	m.mu.Unlock()
	if !started {
		cur = 0
		if latest > m.Backfill {
			cur = latest - m.Backfill
		}
	}
	if started && latest <= cur {
		return nil
	}
	hi := latest
	if hi > cur+m.MaxRange {
		hi = cur + m.MaxRange
	}
	calls := 0
	state := func(n uint64) (acctState, error) {
		calls += 2
		if calls > m.MaxCalls {
			return acctState{}, errBudget
		}
		tag := hexutil.EncodeUint64(n)
		bal, err := m.r.quantity(ctx, chain, "eth_getBalance", []any{self, tag})
		if err != nil {
			return acctState{}, err
		}
		nonce, err := m.r.quantity(ctx, chain, "eth_getTransactionCount", []any{self, tag})
		if err != nil {
			return acctState{}, err
		}
		return acctState{bal, nonce.Uint64()}, nil
	}
	lo, err := state(cur)
	if err != nil {
		if !started && indexer.IsMissingState(err) {
			// No historical state (non-archive node): history starts now.
			m.warnOnce(id, "gas service history: historical balances unavailable, recording from the current block", err)
			m.mu.Lock()
			m.cursor[id], m.since[id] = latest, latest
			m.mu.Unlock()
		}
		return err
	}
	hiState, err := state(hi)
	if err != nil {
		return err
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
	if err := bisect(cur, hi, lo, hiState); err != nil {
		return err
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].block < changes[j].block })
	for _, c := range changes {
		if err := m.block(ctx, chain, id, self, c, links); err != nil {
			return err
		}
	}
	m.mu.Lock()
	m.cursor[id] = hi
	if !started {
		m.since[id] = cur + 1
	}
	m.mu.Unlock()
	return nil
}

// block records every transaction to or from the account in one block where
// its balance or nonce changed.
func (m *GasMonitor) block(ctx context.Context, chain ChainCaller, id int64, self string, c change, links map[string]txLink) error {
	raw, err := chain.Call(ctx, "eth_getBlockByNumber", []any{hexutil.EncodeUint64(c.block), true})
	if err != nil {
		return err
	}
	var b *struct {
		Timestamp    string `json:"timestamp"`
		Transactions []struct {
			Hash  string  `json:"hash"`
			From  string  `json:"from"`
			To    *string `json:"to"`
			Value string  `json:"value"`
		} `json:"transactions"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return err
	}
	if b == nil {
		return errNoBlock
	}
	when := time.Unix(int64(decU64(b.Timestamp)), 0).UTC()
	explained := new(big.Int)
	sw := m.r.store.SharedWallets()
	for _, tx := range b.Transactions {
		from := strings.ToLower(tx.From)
		to := ""
		if tx.To != nil {
			to = strings.ToLower(*tx.To)
		}
		if from != self && to != self {
			continue
		}
		hash := strings.ToLower(tx.Hash)
		rc, err := receiptOf(ctx, chain, hash)
		if err != nil {
			return err
		}
		if rc == nil {
			continue
		}
		ok := rc.Status == "0x1"
		value := decBig(tx.Value)
		var t *store.GasTransfer
		if from == self {
			var link *txLink
			if l, found := links[hash]; found {
				link = &l
			}
			if t, err = m.outgoing(ctx, chain, id, self, hash, rc, link); err != nil {
				return err
			}
			t.Counterparty, t.ValueWei = to, value.String()
			explained.Sub(explained, decBig(t.FeeWei))
			if ok {
				explained.Sub(explained, value)
			}
			if to == self && ok {
				explained.Add(explained, value) // self-transfer: value returns
			}
		} else {
			t = &store.GasTransfer{
				ChainID: id, TxHash: hash, Address: self, Direction: store.GasIn, Kind: store.GasKindRecharge,
				Counterparty: from, ValueWei: value.String(), Success: ok, BlockNumber: c.block, BlockTime: when, CreatedAt: m.r.now(),
			}
			if ok {
				explained.Add(explained, value)
			}
		}
		if err := sw.RecordGasTransfer(ctx, t); err != nil {
			return err
		}
	}
	delta := new(big.Int).Sub(c.after.bal, c.before.bal)
	if extra := new(big.Int).Sub(delta, explained); extra.Sign() > 0 {
		t := &store.GasTransfer{
			ChainID: id, TxHash: fmt.Sprintf("internal:%d", c.block), Address: self, Direction: store.GasIn, Kind: store.GasKindRechargeInternal,
			ValueWei: extra.String(), Success: true, BlockNumber: c.block, BlockTime: when, CreatedAt: m.r.now(),
		}
		if err := sw.RecordGasTransfer(ctx, t); err != nil {
			return err
		}
	}
	return nil
}
