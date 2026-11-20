package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

var ctx = context.Background()

// ---- a small chain with historical state, receipts and logs -------------------

type fLog struct {
	address string
	topics  []string
	data    string
}

type fTx struct {
	hash, from, to string
	value          *big.Int
	ok             bool
	gas            uint64
	logs           []fLog
	// internal value moves performed by the transaction (contract → address), applied if ok
	moves []move
}

type move struct {
	from, to string
	value    *big.Int
}

type fakeChain struct {
	head     uint64
	blocks   map[uint64][]*fTx
	credits  map[uint64]map[string]*big.Int // balance credited without any transaction
	genesis  map[string]*big.Int
	qd       map[string][32]byte // genuine QdAccounts: address → pk hash
	noLogs   bool                // eth_getLogs fails (provider range cap) unless the range is one block
	calls    map[string]int
	noArchiv bool
}

const price = 17

func newChain() *fakeChain {
	return &fakeChain{blocks: map[uint64][]*fTx{}, credits: map[uint64]map[string]*big.Int{}, genesis: map[string]*big.Int{}, qd: map[string][32]byte{}, calls: map[string]int{}}
}

func (c *fakeChain) add(block uint64, tx *fTx) *fTx {
	if tx.gas == 0 {
		tx.gas = 21_000
	}
	if tx.value == nil {
		tx.value = new(big.Int)
	}
	tx.from, tx.to = strings.ToLower(tx.from), strings.ToLower(tx.to)
	c.blocks[block] = append(c.blocks[block], tx)
	if block > c.head {
		c.head = block
	}
	return tx
}

func (c *fakeChain) state(addr string, n uint64) (*big.Int, uint64) {
	bal := new(big.Int)
	if g, ok := c.genesis[addr]; ok {
		bal.Set(g)
	}
	var nonce uint64
	for b := uint64(0); b <= n; b++ {
		if cr, ok := c.credits[b][addr]; ok {
			bal.Add(bal, cr)
		}
		for _, tx := range c.blocks[b] {
			if tx.from == addr {
				nonce++
				bal.Sub(bal, new(big.Int).SetUint64(tx.gas*price))
			}
			if !tx.ok {
				continue
			}
			if tx.from == addr {
				bal.Sub(bal, tx.value)
			}
			if tx.to == addr {
				bal.Add(bal, tx.value)
			}
			for _, m := range tx.moves {
				if m.from == addr {
					bal.Sub(bal, m.value)
				}
				if m.to == addr {
					bal.Add(bal, m.value)
				}
			}
		}
	}
	return bal, nonce
}

func (c *fakeChain) find(hash string) (uint64, int, *fTx) {
	for b, txs := range c.blocks {
		for i, tx := range txs {
			if tx.hash == hash {
				return b, i, tx
			}
		}
	}
	return 0, 0, nil
}

func (c *fakeChain) logIndex(block uint64, txi, li int) int {
	n := 0
	for i := 0; i < txi; i++ {
		if c.blocks[block][i].ok {
			n += len(c.blocks[block][i].logs)
		}
	}
	return n + li
}

func j(v any) (json.RawMessage, error) { b, err := json.Marshal(v); return b, err }

func (c *fakeChain) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	c.calls[method]++
	p := params.([]any)
	switch method {
	case "eth_blockNumber":
		return j(hexutil.EncodeUint64(c.head))
	case "eth_getBalance", "eth_getTransactionCount":
		n, _ := hexutil.DecodeUint64(p[1].(string))
		if c.noArchiv && n+128 < c.head {
			return nil, errors.New("missing trie node")
		}
		bal, nonce := c.state(strings.ToLower(p[0].(string)), n)
		if method == "eth_getBalance" {
			return j(hexutil.EncodeBig(bal))
		}
		return j(hexutil.EncodeUint64(nonce))
	case "eth_getBlockByNumber":
		n, _ := hexutil.DecodeUint64(p[0].(string))
		var txs []map[string]any
		for _, tx := range c.blocks[n] {
			txs = append(txs, map[string]any{"hash": tx.hash, "from": tx.from, "to": tx.to, "value": hexutil.EncodeBig(tx.value)})
		}
		return j(map[string]any{"number": hexutil.EncodeUint64(n), "timestamp": hexutil.EncodeUint64(1_800_000_000 + n*12), "transactions": txs})
	case "eth_getTransactionByHash":
		_, _, tx := c.find(p[0].(string))
		if tx == nil {
			return j(nil)
		}
		return j(map[string]any{"hash": tx.hash, "from": tx.from, "to": tx.to, "value": hexutil.EncodeBig(tx.value)})
	case "eth_getTransactionReceipt":
		b, i, tx := c.find(p[0].(string))
		if tx == nil {
			return j(nil)
		}
		status, logs := "0x0", []map[string]any{}
		if tx.ok {
			status = "0x1"
			for li, l := range tx.logs {
				logs = append(logs, map[string]any{"address": l.address, "topics": l.topics, "data": l.data, "transactionHash": tx.hash, "logIndex": hexutil.EncodeUint64(uint64(c.logIndex(b, i, li)))})
			}
		}
		return j(map[string]any{"status": status, "blockNumber": hexutil.EncodeUint64(b), "gasUsed": hexutil.EncodeUint64(tx.gas), "effectiveGasPrice": hexutil.EncodeUint64(price), "logs": logs})
	case "eth_getLogs":
		f := p[0].(map[string]any)
		from, _ := hexutil.DecodeUint64(f["fromBlock"].(string))
		to, _ := hexutil.DecodeUint64(f["toBlock"].(string))
		if c.noLogs && to-from > 100 {
			return nil, errors.New("query exceeds max block range 100")
		}
		topics := f["topics"].([]any)
		var out []map[string]any
		for b := from; b <= to; b++ {
			for i, tx := range c.blocks[b] {
				if !tx.ok {
					continue
				}
				for li, l := range tx.logs {
					if a, ok := f["address"]; ok && !strings.EqualFold(a.(string), l.address) {
						continue
					}
					match := len(l.topics) >= len(topics)
					for k, t := range topics {
						if match && t != nil && !strings.EqualFold(t.(string), l.topics[k]) {
							match = false
						}
					}
					if match {
						out = append(out, map[string]any{"address": l.address, "topics": l.topics, "data": l.data, "transactionHash": tx.hash, "logIndex": hexutil.EncodeUint64(uint64(c.logIndex(b, i, li)))})
					}
				}
			}
		}
		return j(out)
	case "eth_call":
		m := p[0].(map[string]string)
		to, data := strings.ToLower(m["to"]), hexutil.MustDecode(m["data"])
		word := func(b []byte) (json.RawMessage, error) { return j(hexutil.Encode(common.LeftPadBytes(b, 32))) }
		vd, _ := qdaccount.AccountVerifierCalldata()
		hd, _ := qdaccount.AccountPublicKeyHashCalldata()
		nd, _ := qdaccount.NonceCalldata()
		if h, ok := c.qd[to]; ok {
			switch string(data[:4]) {
			case string(nd[:4]): // execution nonce at the requested block: Executed events emitted so far
				at := c.head
				if tag, ok := p[1].(string); ok && tag != "latest" {
					at, _ = hexutil.DecodeUint64(tag)
				}
				var n int64
				for b := uint64(0); b <= at; b++ {
					for _, tx := range c.blocks[b] {
						for _, l := range tx.logs {
							if tx.ok && l.address == to && l.topics[0] == qdaccount.ExecutedTopic().Hex() {
								n++
							}
						}
					}
				}
				return word(big.NewInt(n).Bytes())
			case string(vd[:4]):
				return word(qdaccount.VerifierAddress().Bytes())
			case string(hd[:4]):
				return word(h[:])
			}
		}
		if to == strings.ToLower(qdaccount.FactoryAddress().Hex()) {
			return word(qdaccount.AccountAddress([32]byte(data[4:36])).Bytes())
		}
		return j("0x")
	}
	return nil, fmt.Errorf("fake: unsupported %s", method)
}

// ---- helpers ---------------------------------------------------------------------

func addr(n int) string { return fmt.Sprintf("0x%040x", n) }

func hash(n int) string { return fmt.Sprintf("0x%064x", n) }

func eth(milli int64) *big.Int { return new(big.Int).Mul(big.NewInt(milli), big.NewInt(1e15)) }

// qdAccount makes a genuine QdAccount address (CREATE2 from the factory for a key hash).
func (c *fakeChain) qdAccount(seed byte) string {
	var h [32]byte
	h[0] = seed
	a := strings.ToLower(qdaccount.AccountAddress(h).Hex())
	c.qd[a] = h
	return a
}

// executed builds an Executed log emitted by account: account → to, value.
func executed(account, to string, value *big.Int, success bool, nonce int64) fLog {
	ev := qdaccount.AccountABI.Events["Executed"]
	body, _ := ev.Inputs.NonIndexed().Pack(common.HexToAddress(to), value, success)
	return fLog{address: account, data: hexutil.Encode(body), topics: []string{
		ev.ID.Hex(), common.BigToHash(big.NewInt(nonce)).Hex(), hash(1000 + int(nonce)), hash(2000 + int(nonce)),
	}}
}

func erc20(token, from, to string, amount int64) fLog {
	return fLog{address: token, topics: []string{erc20TransferTopic, topicFor(from), topicFor(to)}, data: hexutil.Encode(common.LeftPadBytes(big.NewInt(amount).Bytes(), 32))}
}

type world struct {
	t     *testing.T
	st    *memory.Store
	chain *fakeChain
	ix    *Indexer
	// shared smart-account addresses (in the API they come from account keys)
	sharedAddrs []string
}

const chainID = 11155111

func newWorld(t *testing.T) *world {
	st := memory.New()
	c := newChain()
	ix := New(st, func(id int64) (Caller, bool) { return c, id == chainID }, nil)
	ix.ChainIDs = []int64{chainID}
	ix.NoDepthChains = map[int64]bool{chainID: true}
	ix.FullLogChains = map[int64]bool{chainID: true}
	return &world{t: t, st: st, chain: c, ix: ix}
}

// personal registers a personal wallet address for a user.
func (w *world) personal(a string) string {
	w.t.Helper()
	acct := uuid.New()
	if err := w.st.Addresses().Create(ctx, &store.Address{ID: uuid.New(), AccountID: acct, NetworkFamily: store.FamilyEVM, Address: a, CreatedAt: time.Now()}); err != nil {
		w.t.Fatal(err)
	}
	return a
}

// shared registers a shared smart-account address (as account keys do).
func (w *world) shared(a string) string {
	w.sharedAddrs = append(w.sharedAddrs, a)
	return a
}

func (w *world) sync() {
	w.t.Helper()
	if err := w.ix.Sync(ctx, chainID, w.personalAddrs(), false); err != nil {
		w.t.Fatal(err)
	}
	if err := w.ix.Sync(ctx, chainID, w.sharedAddrs, true); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) personalAddrs() []string {
	ws, _ := w.st.ChainIndex().WatchedAddresses(ctx)
	var out []string
	for _, a := range ws {
		if a.Kind == "personal" {
			out = append(out, a.Address)
		}
	}
	return out
}

func (w *world) list(a string) []*store.ChainTransfer {
	w.t.Helper()
	recs, err := w.st.ChainIndex().ListTransfers(ctx, chainID, []string{a}, 0)
	if err != nil {
		w.t.Fatal(err)
	}
	return recs
}

func only(t *testing.T, recs []*store.ChainTransfer, kind string) *store.ChainTransfer {
	t.Helper()
	var found []*store.ChainTransfer
	for _, r := range recs {
		if r.Kind == kind {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want one %s record, got %d of %d: %+v", kind, len(found), len(recs), recs)
	}
	return found[0]
}

// ---- scenarios ---------------------------------------------------------------------

func TestSharedToPersonalAppearsInBothHistoriesWithTheSameHash(t *testing.T) {
	w := newWorld(t)
	relayer := addr(0xee)
	account := w.chain.qdAccount(1)
	alice := w.personal(addr(0xa1))
	w.shared(account)
	w.chain.genesis[account] = eth(30)
	w.chain.genesis[relayer] = eth(1000)
	// Block 10: the relayer calls the QdAccount (value 0); the account pays alice internally.
	w.chain.add(10, &fTx{hash: hash(1), from: relayer, to: account, ok: true, gas: 10_787_755,
		logs: []fLog{executed(account, alice, eth(20), true, 0)}, moves: []move{{account, alice, eth(20)}}})
	w.chain.head = 12
	w.sync()

	in := only(t, w.list(alice), store.TransferQdExecute)
	if in.TxHash != hash(1) || in.From != account || in.To != alice || in.Amount != eth(20).String() || !in.Success || in.TxFrom != relayer || in.BlockNumber != 10 {
		t.Fatalf("recipient record: %+v", in)
	}
	if in.FeeWei != fmt.Sprint(10_787_755*price) || in.GasUsed != 10_787_755 {
		t.Fatalf("gas: %+v", in)
	}
	out := only(t, w.list(account), store.TransferQdExecute)
	if out.TxHash != in.TxHash || out.LogIndex != in.LogIndex {
		t.Fatal("sender and recipient must see the same record")
	}
	// The outer relayer → account call (value 0) is not shown as a transfer.
	if n := len(w.list(account)); n != 1 {
		t.Fatalf("account records: %d", n)
	}
	// Alice was offline throughout; nothing about her came from a client.
	if c, err := w.st.ChainIndex().GetCursor(ctx, chainID, alice); err != nil || c.ScannedThrough != 12 {
		t.Fatalf("cursor: %+v %v", c, err)
	}
}

func TestPersonalToSharedPersonalToPersonalAndSharedToShared(t *testing.T) {
	w := newWorld(t)
	relayer := addr(0xee)
	a1, a2 := w.chain.qdAccount(1), w.chain.qdAccount(2)
	w.shared(a1)
	w.shared(a2)
	bob, carol := w.personal(addr(0xb0)), w.personal(addr(0xc0))
	w.chain.genesis[bob] = eth(1000)
	w.chain.genesis[relayer] = eth(1000)
	w.chain.add(3, &fTx{hash: hash(1), from: bob, to: a1, value: eth(50), ok: true})     // personal → shared
	w.chain.add(4, &fTx{hash: hash(2), from: bob, to: carol, value: eth(7), ok: true})   // personal → personal
	w.chain.add(6, &fTx{hash: hash(3), from: relayer, to: a1, ok: true, gas: 11_000_000, // shared → shared
		logs: []fLog{executed(a1, a2, eth(5), true, 0)}, moves: []move{{a1, a2, eth(5)}}})
	w.chain.head = 8
	w.sync()

	if r := only(t, w.list(a1), store.TransferNative); r.TxHash != hash(1) || r.From != bob || r.Amount != eth(50).String() {
		t.Fatalf("shared received: %+v", r)
	}
	bobRecs := w.list(bob)
	if len(bobRecs) != 2 {
		t.Fatalf("bob: %+v", bobRecs)
	}
	for _, r := range bobRecs {
		if r.From != bob || r.TxFrom != bob || r.FeeWei != fmt.Sprint(21_000*price) {
			t.Fatalf("bob sent: %+v", r)
		}
	}
	if r := only(t, w.list(carol), store.TransferNative); r.TxHash != hash(2) || r.To != carol || r.Amount != eth(7).String() {
		t.Fatalf("carol: %+v", r)
	}
	s := only(t, w.list(a2), store.TransferQdExecute)
	if s.From != a1 || s.To != a2 || s.TxHash != hash(3) {
		t.Fatalf("shared → shared: %+v", s)
	}
	// No internal remainders: every balance change is explained.
	for _, a := range []string{a1, a2, bob, carol} {
		for _, r := range w.list(a) {
			if r.Kind == store.TransferInternal {
				t.Fatalf("unexpected internal record for %s: %+v", a, r)
			}
		}
	}
}

func TestReindexingNeverDuplicates(t *testing.T) {
	w := newWorld(t)
	account := w.chain.qdAccount(1)
	alice := w.personal(addr(0xa1))
	w.shared(account)
	w.chain.genesis[account] = eth(30)
	w.chain.add(5, &fTx{hash: hash(1), from: addr(0xee), to: account, ok: true, logs: []fLog{executed(account, alice, eth(20), true, 0)}, moves: []move{{account, alice, eth(20)}}})
	w.chain.head = 6
	w.sync()
	w.sync()
	// Forget the cursors (as after a crash before saving them): the same blocks are scanned again.
	for _, a := range []string{alice, account} {
		if err := w.st.ChainIndex().PutCursor(ctx, &store.IndexCursor{ChainID: chainID, Address: a, SinceBlock: 1, ScannedThrough: 0}); err != nil {
			t.Fatal(err)
		}
	}
	w.sync()
	if n, m := len(w.list(alice)), len(w.list(account)); n != 1 || m != 1 {
		t.Fatalf("duplicates: alice %d account %d", n, m)
	}
}

func TestFailedTransactionsAreNotSuccessful(t *testing.T) {
	w := newWorld(t)
	relayer := addr(0xee)
	account := w.chain.qdAccount(1)
	alice := w.personal(addr(0xa1))
	w.shared(account)
	w.chain.genesis[account] = eth(30)
	w.chain.genesis[alice] = eth(100)
	w.chain.genesis[relayer] = eth(100)
	// Outer revert (BadNonce): no logs, nothing moves. Found through the relayer's execution record.
	w.chain.add(3, &fTx{hash: hash(1), from: relayer, to: account, ok: false, gas: 1_620_888})
	// Executed with success = false: the account consumed its nonce, the call reverted.
	w.chain.add(4, &fTx{hash: hash(2), from: relayer, to: account, ok: true, logs: []fLog{executed(account, alice, eth(20), false, 0)}})
	// Alice's own failed transfer.
	w.chain.add(5, &fTx{hash: hash(3), from: alice, to: addr(0xb0), value: eth(5), ok: false})
	w.chain.head = 6
	// The relayer's record of the reverted execution.
	w.ix.store = &withExecutions{Store: w.st, execs: []*store.Execution{{ChainID: chainID, AccountAddress: account, TxHash: hash(1), Status: store.ExecFailed}}}
	w.sync()

	for _, r := range append(w.list(account), w.list(alice)...) {
		if r.Success {
			t.Fatalf("a failed transaction is marked successful: %+v", r)
		}
	}
	if r := only(t, w.list(account), store.TransferNative); r.TxHash != hash(1) || r.Success {
		t.Fatalf("outer revert: %+v", r)
	}
	if r := only(t, w.list(account), store.TransferQdExecute); r.TxHash != hash(2) || r.Success || r.To != alice {
		t.Fatalf("inner failure: %+v", r)
	}
	if r := only(t, w.list(alice), store.TransferNative); r.TxHash != hash(3) || r.Success || r.FeeWei == "" {
		t.Fatalf("alice failed send: %+v", r)
	}
}

// withExecutions overlays relayer execution records on the memory store.
type withExecutions struct {
	*memory.Store
	execs []*store.Execution
}

func (w *withExecutions) SharedWallets() store.SharedWallets {
	return &execOverlay{SharedWallets: w.Store.SharedWallets(), execs: w.execs}
}

type execOverlay struct {
	store.SharedWallets
	execs []*store.Execution
}

func (o *execOverlay) ListExecutions(context.Context, []store.ExecutionStatus) ([]*store.Execution, error) {
	return o.execs, nil
}

func TestForgedExecutedEventsAndERC20AndInternalTransfers(t *testing.T) {
	w := newWorld(t)
	alice := w.personal(addr(0xa1))
	fake := addr(0xbad) // not a QdAccount: its "Executed" event proves nothing
	token := addr(0x70c)
	// It does send 1 wei, so the block is examined, and claims 999 ETH in an Executed-shaped event.
	w.chain.add(3, &fTx{hash: hash(1), from: addr(0xee), to: fake, ok: true, logs: []fLog{executed(fake, alice, eth(999), true, 0)}, moves: []move{{fake, alice, big.NewInt(1)}}})
	w.chain.add(4, &fTx{hash: hash(2), from: addr(0xee), to: token, ok: true, logs: []fLog{erc20(token, addr(0xee), alice, 1234)}})
	// A contract the index cannot decode sends alice ETH: only her balance shows it.
	w.chain.credits[6] = map[string]*big.Int{alice: eth(3)}
	w.chain.head = 7
	w.sync()

	recs := w.list(alice)
	for _, r := range recs {
		if r.Kind == store.TransferQdExecute {
			t.Fatalf("forged Executed event recorded: %+v", r)
		}
	}
	if r := only(t, recs, store.TransferERC20); r.Token != token || r.Amount != "1234" || r.To != alice || r.TxHash != hash(2) {
		t.Fatalf("erc20: %+v", r)
	}
	// What alice really received from the forging contract (1 wei) and from the unknown one (3 ETH) is internal.
	var internal []*store.ChainTransfer
	for _, r := range recs {
		if r.Kind == store.TransferInternal {
			internal = append(internal, r)
		}
	}
	if len(internal) != 2 || internal[0].Amount != eth(3).String() || internal[0].BlockNumber != 6 || !strings.HasPrefix(internal[0].TxHash, "internal:6:") ||
		internal[1].Amount != "1" || internal[1].BlockNumber != 3 {
		t.Fatalf("internal: %+v", internal)
	}
}

func TestProviderLogRangeCapAndNoArchive(t *testing.T) {
	w := newWorld(t)
	alice := w.personal(addr(0xa1))
	token := addr(0x70c)
	w.chain.noLogs = true // provider allows at most 100 blocks per eth_getLogs
	w.chain.add(1500, &fTx{hash: hash(1), from: addr(0xee), to: token, ok: true, logs: []fLog{erc20(token, addr(0xee), alice, 5)}})
	w.chain.head = 3000
	w.sync()
	if len(w.list(alice)) != 1 {
		t.Fatal("erc20 not found with a capped log range")
	}

	w2 := newWorld(t)
	w2.chain.noArchiv = true
	bob := w2.personal(addr(0xb0))
	w2.chain.head = 100_000
	w2.sync()
	c, err := w2.st.ChainIndex().GetCursor(ctx, chainID, bob)
	if err != nil || c.ScannedThrough != 100_000 || c.SinceBlock != 100_001 {
		t.Fatalf("non-archive start: %+v %v", c, err)
	}
}

func TestIndexSurvivesRestart(t *testing.T) {
	w := newWorld(t)
	account := w.chain.qdAccount(1)
	alice := w.personal(addr(0xa1))
	w.shared(account)
	w.chain.genesis[account] = eth(30)
	w.chain.add(5, &fTx{hash: hash(1), from: addr(0xee), to: account, ok: true, logs: []fLog{executed(account, alice, eth(20), true, 0)}, moves: []move{{account, alice, eth(20)}}})
	w.chain.head = 6
	w.sync()
	path := filepath.Join(t.TempDir(), "store.json")
	if _, err := w.st.Save(path, [32]byte{}); err != nil {
		t.Fatal(err)
	}
	restarted := memory.New()
	if ok, err := restarted.Load(path); !ok || err != nil {
		t.Fatal(ok, err)
	}
	recs, _ := restarted.ChainIndex().ListTransfers(ctx, chainID, []string{alice}, 0)
	c, err := restarted.ChainIndex().GetCursor(ctx, chainID, alice)
	if len(recs) != 1 || recs[0].TxHash != hash(1) || err != nil || c.ScannedThrough != 6 {
		t.Fatalf("after restart: %+v %+v %v", recs, c, err)
	}
	if ws, _ := restarted.ChainIndex().WatchedAddresses(ctx); len(ws) != 1 || ws[0].Address != alice {
		t.Fatalf("watched after restart: %+v", ws)
	}
	// A restarted index continues from the cursor and does not duplicate.
	w.st = restarted
	w.ix.store = restarted
	w.sync()
	if recs, _ := restarted.ChainIndex().ListTransfers(ctx, chainID, []string{alice}, 0); len(recs) != 1 {
		t.Fatalf("duplicated after restart: %d", len(recs))
	}
}

// limited fails every other call with a provider rate-limit error.
type limited struct {
	Caller
	n int
}

func (l *limited) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	l.n++
	if l.n%2 == 1 {
		return nil, errors.New("Your app has exceeded its compute units per second capacity")
	}
	return l.Caller.Call(ctx, method, params)
}

func TestRateLimitedProviderIsRetriedNotRangeHalved(t *testing.T) {
	w := newWorld(t)
	alice := w.personal(addr(0xa1))
	token := addr(0x70c)
	w.chain.add(1500, &fTx{hash: hash(1), from: addr(0xee), to: token, ok: true, logs: []fLog{erc20(token, addr(0xee), alice, 5)}})
	w.chain.head = 3000
	lim := &limited{Caller: w.chain}
	w.ix.chains = func(id int64) (Caller, bool) { return lim, id == chainID }
	w.sync()
	if len(w.list(alice)) != 1 {
		t.Fatal("transfer not indexed through a rate-limited provider")
	}
	// Without halving, two log queries cover 3000 blocks in 2000-block chunks: 2 × 2 = 4 calls.
	if n := w.chain.calls["eth_getLogs"]; n != 4 {
		t.Fatalf("eth_getLogs calls: %d (rate limits must not shrink the range)", n)
	}
}

// eip7708 is the native-transfer log a chain with EIP-7708 emits for every ETH move.
func eip7708(from, to string, value *big.Int) fLog {
	return fLog{address: eip7708System, topics: []string{erc20TransferTopic, topicFor(from), topicFor(to)}, data: hexutil.Encode(common.LeftPadBytes(value.Bytes(), 32))}
}

// Sepolia since Amsterdam: native ETH transfers emit Transfer logs from the
// system address. They are native ETH (never a token), counted once, and give
// internal transfers an exact transaction hash.
func TestEIP7708NativeTransferLogs(t *testing.T) {
	w := newWorld(t)
	relayer := addr(0xee)
	account := w.chain.qdAccount(1)
	alice := w.personal(addr(0xa1))
	bob := w.personal(addr(0xb0))
	unknown := addr(0xc0de) // some contract that forwards ETH
	w.shared(account)
	w.chain.genesis[account] = eth(30)
	w.chain.genesis[bob] = eth(100)
	// Shared → alice: Executed + its 7708 log.
	w.chain.add(3, &fTx{hash: hash(1), from: relayer, to: account, ok: true,
		logs: []fLog{eip7708(account, alice, eth(20)), executed(account, alice, eth(20), true, 0)}, moves: []move{{account, alice, eth(20)}}})
	// Bob → account: the outer value + its 7708 log.
	w.chain.add(4, &fTx{hash: hash(2), from: bob, to: account, value: eth(10), ok: true, logs: []fLog{eip7708(bob, account, eth(10))}})
	// Bob → unknown contract → alice (internal): only the 7708 log names alice.
	w.chain.add(5, &fTx{hash: hash(3), from: bob, to: unknown, value: eth(4), ok: true,
		logs: []fLog{eip7708(bob, unknown, eth(4)), eip7708(unknown, alice, eth(4))}, moves: []move{{unknown, alice, eth(4)}}})
	w.chain.genesis[unknown] = eth(0)
	w.chain.head = 6
	w.sync()

	for _, who := range []string{alice, account, bob} {
		for _, r := range w.list(who) {
			if r.Kind == store.TransferERC20 || r.Kind == store.TransferInternal {
				t.Fatalf("%s: native ETH recorded as %s: %+v", who, r.Kind, r)
			}
		}
	}
	aliceRecs := w.list(alice)
	if len(aliceRecs) != 2 {
		t.Fatalf("alice: %+v", aliceRecs)
	}
	only(t, aliceRecs, store.TransferQdExecute)
	in := only(t, aliceRecs, store.TransferNative)
	if in.TxHash != hash(3) || in.From != unknown || in.Amount != eth(4).String() || in.LogIndex < 0 {
		t.Fatalf("internal transfer with a real hash: %+v", in)
	}
	if r := only(t, w.list(account), store.TransferNative); r.TxHash != hash(2) || r.LogIndex != store.LogIndexTx {
		t.Fatalf("bob → account counted once: %+v", r)
	}
}

// A public chain behind a provider that caps eth_getLogs at 10 blocks (Alchemy's
// free tier): the cap is learned once, and wide log scans cover only the
// newest LogWindow blocks of a first indexing; native ETH comes from bisection.
func TestPublicChainLogWindowAndLearnedRange(t *testing.T) {
	w := newWorld(t)
	w.ix.FullLogChains = nil
	w.ix.LogWindow = 100
	w.chain.noLogs = true // > 100 blocks refused; halving from 2000 lands on 62
	alice := w.personal(addr(0xa1))
	token := addr(0x70c)
	w.chain.genesis[addr(0xee)] = eth(100)
	w.chain.add(1_000, &fTx{hash: hash(1), from: addr(0xee), to: token, ok: true, logs: []fLog{erc20(token, addr(0xee), alice, 5)}}) // old token transfer
	w.chain.add(1_500, &fTx{hash: hash(2), from: addr(0xee), to: alice, value: eth(1), ok: true})                                    // old native transfer
	w.chain.add(2_950, &fTx{hash: hash(3), from: addr(0xee), to: token, ok: true, logs: []fLog{erc20(token, addr(0xee), alice, 7)}}) // recent token transfer
	w.chain.head = 3_000
	w.sync()
	got := map[string]bool{}
	for _, r := range w.list(alice) {
		got[r.TxHash] = true
	}
	if !got[hash(2)] || !got[hash(3)] || got[hash(1)] {
		t.Fatalf("want old native + recent token (old token outside the log window): %v", got)
	}
	first := w.chain.calls["eth_getLogs"]
	// Steady state: the learned range is used directly, no more failed wide queries.
	w.chain.head = 3_060
	w.sync()
	if extra := w.chain.calls["eth_getLogs"] - first; extra > 2*2 {
		t.Fatalf("eth_getLogs calls for 60 new blocks: %d", extra)
	}
}

func TestStatedRange(t *testing.T) {
	for msg, want := range map[string]uint64{
		"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.": 10,
		"query exceeds max block range 100":    100,
		"block range limit of 2000 exceeded":   2000,
		"maximum range is 500":                 500,
		"execution reverted":                   0,
		"Your app has exceeded its throughput": 0,
	} {
		if got := statedRange(errors.New(msg)); got != want {
			t.Errorf("%q: %d, want %d", msg, got, want)
		}
	}
}

// A request never waits behind (or duplicates) a pass already indexing the
// address, and says so instead of claiming it is up to date.
func TestSyncReportsIndexingWhileAPassRuns(t *testing.T) {
	w := newWorld(t)
	alice := w.personal(addr(0xa1))
	w.chain.head = 10
	unlock, ok := w.ix.lock(chainID, alice, false)
	if !ok {
		t.Fatal("lock")
	}
	if err := w.ix.Sync(ctx, chainID, []string{alice}, false); !errors.Is(err, ErrIndexing) {
		t.Fatalf("while a pass runs: %v", err)
	}
	unlock()
	if err := w.ix.Sync(ctx, chainID, []string{alice}, false); err != nil {
		t.Fatalf("after: %v", err)
	}
	// MaxRange reached before the head: still indexing.
	w.chain.head = 10_000
	w.ix.MaxRange = 1_000
	if err := w.ix.Sync(ctx, chainID, []string{alice}, false); !errors.Is(err, ErrIndexing) {
		t.Fatalf("partial pass: %v", err)
	}
	if err := w.ix.Sync(ctx, chainID, []string{addr(0xa1)}, false); !errors.Is(err, ErrIndexing) {
		t.Fatalf("second partial pass: %v", err)
	}
	if c, _ := w.st.ChainIndex().GetCursor(ctx, chainID, alice); c.ScannedThrough != 2_010 {
		t.Fatalf("progress kept across passes: %d", c.ScannedThrough)
	}
}

// flaky fails balance reads with a transient error (timeout / rate limit).
type flaky struct {
	Caller
	failing bool
}

func (f *flaky) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if f.failing && method == "eth_getBalance" {
		return nil, errors.New(`rpc eth_getBalance failed: Post "https://eth-sepolia.example": context deadline exceeded`)
	}
	return f.Caller.Call(ctx, method, params)
}

// Seen on public Sepolia: a balance read cut off by a request deadline was
// taken for "no archive state" and the cursor jumped to the head, losing the
// address's history. A transient error must leave the cursor where it was.
func TestTransientStateErrorsNeverSkipHistory(t *testing.T) {
	w := newWorld(t)
	alice := w.personal(addr(0xa1))
	w.chain.genesis[addr(0xee)] = eth(100)
	w.chain.add(500, &fTx{hash: hash(1), from: addr(0xee), to: alice, value: eth(1), ok: true})
	w.chain.head = 1_000
	f := &flaky{Caller: w.chain, failing: true}
	w.ix.chains = func(id int64) (Caller, bool) { return f, id == chainID }
	if err := w.ix.Sync(ctx, chainID, []string{alice}, false); err == nil {
		t.Fatal("a failing read must fail the pass")
	}
	if c, err := w.st.ChainIndex().GetCursor(ctx, chainID, alice); err == nil && c.ScannedThrough >= 500 {
		t.Fatalf("cursor skipped history after a transient error: %+v", c)
	}
	f.failing = false
	w.sync()
	if r := only(t, w.list(alice), store.TransferNative); r.TxHash != hash(1) {
		t.Fatalf("history after recovery: %+v", r)
	}
}

// Seen on public Sepolia: a shared account received 0.02 ETH and then sent
// 0.02 ETH; its balance before and after was equal and a contract's
// transaction count never changes, so bisection on (balance, tx count) saw
// nothing. The QdAccount execution nonce makes both visible, without logs.
func TestSharedAccountReceiveThenSendSameAmountWithoutLogs(t *testing.T) {
	w := newWorld(t)
	w.ix.FullLogChains = nil
	w.ix.LogWindow = 1
	w.ix.logRange[chainID] = 1 // a provider that caps log ranges: wide log scans cover only the newest block
	relayer, bob := addr(0xee), w.personal(addr(0xb0))
	account := w.chain.qdAccount(1)
	w.shared(account)
	w.chain.genesis[account] = eth(10)
	w.chain.genesis[bob] = eth(100)
	w.chain.add(300, &fTx{hash: hash(1), from: bob, to: account, value: eth(20), ok: true})                                                   // +0.02
	w.chain.add(320, &fTx{hash: hash(2), from: relayer, to: account, ok: true, logs: []fLog{executed(account, addr(0xc0), eth(20), true, 0)}, // −0.02
		moves: []move{{account, addr(0xc0), eth(20)}}})
	w.chain.add(340, &fTx{hash: hash(3), from: relayer, to: account, ok: true, logs: []fLog{executed(account, addr(0xc0), eth(1), false, 1)}}) // inner call failed: no ETH moved
	w.chain.head = 1_000
	if err := w.ix.Sync(ctx, chainID, []string{account}, true); err != nil {
		t.Fatal(err)
	}
	got := map[string]*store.ChainTransfer{}
	for _, r := range w.list(account) {
		got[r.TxHash] = r
	}
	if got[hash(1)] == nil || got[hash(2)] == nil || got[hash(2)].Kind != store.TransferQdExecute || got[hash(3)] == nil || got[hash(3)].Success {
		t.Fatalf("receive, send and failed execution must all be found: %+v", got)
	}
	if w.chain.calls["eth_getLogs"] > 10 {
		t.Fatalf("found through logs, not bisection: %d log queries", w.chain.calls["eth_getLogs"])
	}
}

// Background rounds advance every address one step at a time: one address's
// long catch-up never keeps the others (and their fresh activity) waiting.
func TestBackgroundRoundsTakeTurns(t *testing.T) {
	w := newWorld(t)
	alice, bob := w.personal(addr(0xa1)), w.personal(addr(0xb2))
	w.chain.head = 10
	w.ix.TickChain(ctx, chainID) // both indexed to 10
	w.chain.head = 10_010        // a long outage
	w.ix.StepBlocks = 1_000
	w.ix.TickChain(ctx, chainID)
	for _, a := range []string{alice, bob} {
		if c, _ := w.st.ChainIndex().GetCursor(ctx, chainID, a); c.ScannedThrough != 1_010 {
			t.Fatalf("%s after one round: scanned through %d, want 1010", a, c.ScannedThrough)
		}
	}
	// An on-demand Sync still goes as far as MaxRange in one call.
	if err := w.ix.Sync(ctx, chainID, []string{alice}, false); err != nil {
		t.Fatal(err)
	}
	if c, _ := w.st.ChainIndex().GetCursor(ctx, chainID, alice); c.ScannedThrough != 10_010 {
		t.Fatalf("sync: %d", c.ScannedThrough)
	}
}
