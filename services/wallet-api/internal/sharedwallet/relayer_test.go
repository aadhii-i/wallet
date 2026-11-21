package sharedwallet

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/qdraccoon"
	"github.com/qdwallet/wallet-api/internal/rpc"
	"github.com/qdwallet/wallet-api/internal/store"
)

// fakeChain is a scripted EVM JSON-RPC endpoint with just enough semantics
// for the relayer: code, balances, the verifier's matrix entries, the
// account's nonce, transactions and receipts. It applies each transaction's
// effect when mined, like a chain would. It never verifies Raccoon
// signatures (the contracts are tested against the real verifier on Anvil);
// it tests the relayer's decisions.
type fakeChain struct {
	t         *testing.T
	chainID   int64
	code      map[common.Address]bool
	balances  map[common.Address]*big.Int
	entries   map[int]bool
	nonce     uint64 // QdAccount nonce
	relNonce  uint64 // relayer EOA nonce (mined)
	block     uint64
	autoMine  bool
	pending   []*types.Transaction
	receipts  map[common.Hash]map[string]any
	sent      []*types.Transaction
	revertNth map[int]bool // the n-th sent transaction (1-based) reverts when mined
	failCalls bool         // eth_call to execute reverts (simulation)
	alterTo   bool         // Executed event reports a different destination
	innerFail bool         // the inner call fails (Executed success = false)
	wrongPK   bool         // the account at the address has another public-key hash
	pkHash    [32]byte
	account   common.Address
	call      *qdaccount.Call
	message   [32]byte
	rpcDown   bool
	throttle  bool   // the provider answers HTTP 429
	rejectRaw string // eth_sendRawTransaction error
	// holdExecutes keeps transactions to the account in the mempool (others still auto-mine).
	holdExecutes bool
}

func newFakeChain(t *testing.T, chainID int64) *fakeChain {
	return &fakeChain{t: t, chainID: chainID, code: map[common.Address]bool{qdaccount.Deployer: true}, balances: map[common.Address]*big.Int{},
		entries: map[int]bool{}, receipts: map[common.Hash]map[string]any{}, revertNth: map[int]bool{}, autoMine: true, block: 100}
}

func (f *fakeChain) bal(a common.Address) *big.Int {
	if b, ok := f.balances[a]; ok {
		return b
	}
	return new(big.Int)
}

func q(v uint64) string { return hexutil.EncodeUint64(v) }

func (f *fakeChain) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	if f.rpcDown {
		return nil, errors.New("dial tcp: https://eth-sepolia.example/v2/SECRETKEY connection refused")
	}
	if f.throttle {
		return nil, &rpc.RateLimitedError{Provider: "alchemy"}
	}
	p, _ := params.([]any)
	j := func(v any) (json.RawMessage, error) { b, err := json.Marshal(v); return b, err }
	switch method {
	case "eth_chainId":
		return j(q(uint64(f.chainID)))
	case "eth_getCode":
		if f.code[common.HexToAddress(p[0].(string))] {
			return j("0x6080")
		}
		return j("0x")
	case "eth_getBalance":
		return j(hexutil.EncodeBig(f.bal(common.HexToAddress(p[0].(string)))))
	case "eth_getBlockByNumber":
		return j(map[string]string{"baseFeePerGas": "0xf", "gasLimit": q(60_000_000), "timestamp": q(1_800_000_000 + f.block*12), "number": q(f.block)})
	case "eth_maxPriorityFeePerGas":
		return j("0x2")
	case "eth_estimateGas":
		return j(q(1_000_000))
	case "eth_getTransactionCount":
		n := f.relNonce
		if p[1] == "pending" {
			n += uint64(len(f.pending))
		}
		return j(q(n))
	case "eth_call":
		return f.ethCall(p[0].(map[string]string))
	case "eth_sendRawTransaction":
		if f.rejectRaw != "" {
			return nil, errors.New(f.rejectRaw)
		}
		var tx types.Transaction
		if err := tx.UnmarshalBinary(hexutil.MustDecode(p[0].(string))); err != nil {
			return nil, err
		}
		for _, s := range f.sent {
			if s.Hash() == tx.Hash() {
				return nil, errors.New("already known")
			}
		}
		f.sent = append(f.sent, &tx)
		f.pending = append(f.pending, &tx)
		if f.autoMine && !(f.holdExecutes && *tx.To() == f.account) {
			f.mine()
		}
		return j(tx.Hash().Hex())
	case "eth_getTransactionReceipt":
		if r, ok := f.receipts[common.HexToHash(p[0].(string))]; ok {
			return j(r)
		}
		return j(nil)
	case "eth_getTransactionByHash":
		h := common.HexToHash(p[0].(string))
		for _, s := range f.pending {
			if s.Hash() == h {
				return j(map[string]any{"hash": h.Hex(), "blockNumber": nil})
			}
		}
		if _, ok := f.receipts[h]; ok {
			return j(map[string]any{"hash": h.Hex()})
		}
		return j(nil)
	}
	return nil, fmt.Errorf("fake chain: unsupported %s", method)
}

func sel(a interface {
	Pack(string, ...any) ([]byte, error)
}, name string, args ...any) []byte {
	b, _ := a.Pack(name, args...)
	return b[:4]
}

func (f *fakeChain) ethCall(m map[string]string) (json.RawMessage, error) {
	to, data := common.HexToAddress(m["to"]), hexutil.MustDecode(m["data"])
	word := func(b []byte) (json.RawMessage, error) {
		out, _ := json.Marshal(hexutil.Encode(common.LeftPadBytes(b, 32)))
		return out, nil
	}
	if !f.code[to] {
		return word(nil) // calls to empty accounts return nothing
	}
	s := string(data[:4])
	switch {
	case to == qdaccount.VerifierAddress() && s == string(qdaccount.VerifierABI.Methods["matrixEntry"].ID):
		idx := new(big.Int).SetBytes(data[36:68]).Int64()
		if f.entries[int(idx)] {
			return word(common.HexToAddress("0x00000000000000000000000000000000000000e1").Bytes())
		}
		return word(nil)
	case to == qdaccount.FactoryAddress() && s == string(qdaccount.FactoryABI.Methods["accountAddress"].ID):
		return word(qdaccount.AccountAddress([32]byte(data[4:36])).Bytes())
	case to == f.account && s == string(qdaccount.AccountABI.Methods["verifier"].ID):
		return word(qdaccount.VerifierAddress().Bytes())
	case to == f.account && s == string(qdaccount.AccountABI.Methods["publicKeyHash"].ID):
		h := f.pkHash
		if f.wrongPK {
			h[0] ^= 1
		}
		return word(h[:])
	case to == f.account && s == string(qdaccount.AccountABI.Methods["nonce"].ID):
		return word(new(big.Int).SetUint64(f.nonce).Bytes())
	case to == f.account && s == string(qdaccount.AccountABI.Methods["execute"].ID):
		if f.failCalls {
			return nil, errors.New("execution reverted: InvalidSignature()")
		}
		return word([]byte{1})
	}
	return nil, fmt.Errorf("fake chain: unknown call to %s", to.Hex())
}

// mine includes every pending transaction in a new block.
func (f *fakeChain) mine() {
	for _, tx := range f.pending {
		f.block++
		f.relNonce++
		from, _ := types.Sender(types.LatestSignerForChainID(big.NewInt(f.chainID)), tx)
		status, logs := "0x1", []map[string]any{}
		n := 0
		for i, s := range f.sent {
			if s.Hash() == tx.Hash() {
				n = i + 1
			}
		}
		if f.revertNth[n] {
			status = "0x0"
		} else {
			logs = f.apply(tx)
			if logs == nil {
				status = "0x0"
				logs = []map[string]any{}
			}
		}
		f.receipts[tx.Hash()] = map[string]any{
			"status": status, "blockNumber": q(f.block), "gasUsed": q(tx.Gas() * 8 / 10), "effectiveGasPrice": q(17),
			"to": strings.ToLower(tx.To().Hex()), "from": strings.ToLower(from.Hex()), "logs": logs,
		}
	}
	f.pending = nil
}

// apply executes a transaction's effect; nil means it reverted.
func (f *fakeChain) apply(tx *types.Transaction) []map[string]any {
	to, data := *tx.To(), tx.Data()
	switch {
	case to == qdaccount.Deployer && string(data) == string(qdaccount.DeployerCalldata(qdaccount.VerifierInitCode())):
		if f.code[qdaccount.VerifierAddress()] {
			return nil // CREATE2 collision
		}
		f.code[qdaccount.VerifierAddress()] = true
	case to == qdaccount.Deployer && string(data) == string(qdaccount.DeployerCalldata(qdaccount.FactoryInitCode())):
		if f.code[qdaccount.FactoryAddress()] {
			return nil
		}
		f.code[qdaccount.FactoryAddress()] = true
	case to == qdaccount.VerifierAddress() && string(data[:4]) == string(qdaccount.VerifierABI.Methods["expandMatrix"].ID):
		first := int(new(big.Int).SetBytes(data[36:68]).Int64())
		count := int(new(big.Int).SetBytes(data[68:100]).Int64())
		for i := first; i < first+count; i++ {
			f.entries[i] = true
		}
	case to == qdaccount.FactoryAddress():
		f.code[f.account] = true
	case to == f.account:
		if f.nonce != f.call.Nonce.Uint64() {
			return nil // BadNonce
		}
		f.nonce++
		success := !f.innerFail
		if success {
			f.balances[f.account] = new(big.Int).Sub(f.bal(f.account), f.call.Value)
			f.balances[f.call.To] = new(big.Int).Add(f.bal(f.call.To), f.call.Value)
		}
		evTo := f.call.To
		if f.alterTo {
			evTo = common.HexToAddress("0x000000000000000000000000000000000000dEaD")
		}
		ev := qdaccount.AccountABI.Events["Executed"]
		body, err := ev.Inputs.NonIndexed().Pack(evTo, f.call.Value, success)
		if err != nil {
			f.t.Fatal(err)
		}
		return []map[string]any{{
			"address": strings.ToLower(f.account.Hex()),
			"topics":  []string{ev.ID.Hex(), common.BigToHash(f.call.Nonce).Hex(), common.Hash(f.message).Hex(), common.Hash(f.call.ProposalDigest).Hex()},
			"data":    hexutil.Encode(body),
		}}
	}
	return []map[string]any{}
}

// relayerEnv: a signed (coordinator-verified) proposal with a pending
// execution, a relayer and a fake chain, sharing one clock.
type relayerEnv struct {
	*env
	owner  *participant
	users  []*participant
	r      *Relayer
	chain  *fakeChain
	key    *ecdsa.PrivateKey
	prop   *store.Proposal
	relay  common.Address
	recip  common.Address
	value  *big.Int
	execID func() *store.Execution
}

func newRelayerEnv(t *testing.T) *relayerEnv {
	e := newEnv(t)
	_, users, prop, signers := e.approvedProposal(3)
	v := must(e.svc.StartSigning(ctx, signers[0].p, prop.ID))
	sw := e.st.SharedWallets()
	for round := 1; round <= 3; round++ {
		for i, idx := range v.Session.Act {
			if _, err := sw.AddSigningMessage(ctx, &store.SigningMessage{SessionID: v.Session.ID, Round: round, PartyIndex: idx,
				MemberID: v.Session.SignerMemberIDs[i], Payload: []byte{1}, DeviceSignature: []byte{1}}, e.clock, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The coordinator verified this signature (tested elsewhere); the relayer only checks shape and binding.
	if _, err := sw.CompleteSigningSession(ctx, v.Session.ID, make([]byte, qdraccoon.SignatureBytes), e.clock); err != nil {
		t.Fatal(err)
	}
	prop = must(sw.GetProposal(ctx, prop.ID))
	key, _ := crypto.GenerateKey()
	chain := newFakeChain(t, prop.ChainID)
	re := &relayerEnv{env: e, owner: users[0], users: users, chain: chain, key: key, prop: prop, relay: crypto.PubkeyToAddress(key.PublicKey)}
	re.r = NewRelayer(e.st, func(id int64) (ChainCaller, bool) { return chain, id == prop.ChainID }, map[int64]*ecdsa.PrivateKey{prop.ChainID: key}, nil)
	re.r.now = func() time.Time { return e.clock }
	call := must(ProposalCall(prop))
	ss, _, err := sw.GetSigningSession(ctx, v.Session.ID, e.clock)
	if err != nil {
		t.Fatal(err)
	}
	ak := must(sw.GetAccountKey(ctx, prop.AccountID, ss.KeygenID))
	copy(chain.pkHash[:], ak.PublicKeyHash)
	chain.account, chain.call = common.HexToAddress(ak.Address), call
	copy(chain.message[:], ss.Message)
	re.recip, re.value = call.To, call.Value
	re.execID = func() *store.Execution { return must(sw.GetExecution(ctx, prop.ID)) }
	return re
}

// fund gives the shared account and the relayer plenty of ETH.
func (re *relayerEnv) fund() {
	re.chain.balances[re.chain.account] = new(big.Int).Mul(big.NewInt(5), big.NewInt(1e18))
	re.chain.balances[re.relay] = new(big.Int).Mul(big.NewInt(1), big.NewInt(1e18))
}

// run processes passes, advancing the clock past any wait, until the
// execution leaves pending/submitted or the pass budget is exhausted.
func (re *relayerEnv) run(passes int) *store.Execution {
	for i := 0; i < passes; i++ {
		if err := re.r.ProcessOnce(ctx); err != nil {
			re.t.Fatal(err)
		}
		ex := re.execID()
		if ex.Status == store.ExecConfirmed || ex.Status == store.ExecFailed {
			return ex
		}
		if ex.NextAttemptAt != nil && re.clock.Before(*ex.NextAttemptAt) {
			re.clock = *ex.NextAttemptAt
		}
	}
	return re.execID()
}

func (re *relayerEnv) lifecycle() string {
	return must(re.svc.GetProposal(ctx, re.owner.p, re.prop.ID)).Lifecycle()
}

// ---- tests -----------------------------------------------------------------------

func TestRelayerFullSetupAndConfirmedExecution(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	before := re.chain.bal(re.recip)
	accBefore := re.chain.bal(re.chain.account)
	ex := re.run(100)
	if ex.Status != store.ExecConfirmed || ex.Stage != store.ExecStageConfirmed {
		t.Fatalf("not confirmed: %s/%s %s", ex.Status, ex.Stage, ex.LastError)
	}
	// verifier, factory, 10 matrix pairs, account = 13 one-time setup transactions, then one execute.
	if len(ex.SetupTxs) != 13 || len(re.chain.sent) != 14 {
		t.Fatalf("setup txs %d, sent %d", len(ex.SetupTxs), len(re.chain.sent))
	}
	if got := new(big.Int).Sub(re.chain.bal(re.recip), before); got.Cmp(re.value) != 0 {
		t.Fatalf("recipient received %s", got)
	}
	if got := new(big.Int).Sub(accBefore, re.chain.bal(re.chain.account)); got.Cmp(re.value) != 0 {
		t.Fatalf("account paid %s", got)
	}
	if ex.TxHash == "" || ex.BlockNumber == nil || ex.GasUsed == nil || ex.TxNonce == nil || ex.EffectiveGasPrice != "17" || ex.BlockTime == nil ||
		ex.ExecutedTo != strings.ToLower(re.recip.Hex()) || ex.ExecutedValue != re.value.String() || ex.CallSuccess == nil || !*ex.CallSuccess {
		t.Fatalf("receipt details: %+v", ex)
	}
	if !strings.EqualFold(ex.RelayerAddress, re.relay.Hex()) {
		t.Fatal("relayer address not recorded")
	}
	if lc := re.lifecycle(); lc != "confirmed" {
		t.Fatalf("lifecycle %s", lc)
	}
	// Nothing more is ever sent for a confirmed execution.
	n := len(re.chain.sent)
	re.run(5)
	if len(re.chain.sent) != n {
		t.Fatal("transactions sent after confirmation")
	}
}

func TestRelayerMissingKeyAndRPCChainMismatch(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	re.r.keys = map[int64]*ecdsa.PrivateKey{}
	ex := re.run(1)
	if ex.Status != store.ExecPending || ex.Stage != store.ExecStageRelayerUnavailable ||
		!strings.Contains(ex.LastError, fmt.Sprintf("RELAYER_PRIVATE_KEY_%d", re.prop.ChainID)) || len(re.chain.sent) != 0 {
		t.Fatalf("missing key: %s %s %q", ex.Status, ex.Stage, ex.LastError)
	}
	if lc := re.lifecycle(); lc != "relayer_unavailable" {
		t.Fatalf("lifecycle %s", lc)
	}
	// Registered key: the next pass proceeds.
	re.r.keys = map[int64]*ecdsa.PrivateKey{re.prop.ChainID: re.key}
	re.chain.chainID = 1 // RPC points at another chain
	ex = re.run(1)
	if ex.Stage != store.ExecStageRelayerUnavailable || !strings.Contains(ex.LastError, "reports chain id 1") || len(re.chain.sent) != 0 {
		t.Fatalf("chain mismatch: %s %q", ex.Stage, ex.LastError)
	}
	re.chain.chainID = re.prop.ChainID
	re.chain.rpcDown = true
	ex = re.run(1)
	if strings.Contains(ex.LastError, "SECRETKEY") || strings.Contains(ex.LastError, "https://") {
		t.Fatalf("RPC URL leaked into status: %q", ex.LastError)
	}
	re.chain.rpcDown = false
	if ex = re.run(100); ex.Status != store.ExecConfirmed {
		t.Fatalf("after fixing configuration: %s %q", ex.Status, ex.LastError)
	}
}

func TestRelayerWaitsForFundsWithoutSpending(t *testing.T) {
	re := newRelayerEnv(t)
	// Shared account empty: nothing is spent on setup.
	re.chain.balances[re.relay] = big.NewInt(1e18)
	ex := re.run(3)
	if ex.Stage != store.ExecStageAccountFunds || len(re.chain.sent) != 0 || !strings.Contains(ex.LastError, re.chain.account.Hex()) {
		t.Fatalf("account funds: %s %q sent=%d", ex.Stage, ex.LastError, len(re.chain.sent))
	}
	if lc := re.lifecycle(); lc != "insufficient_account_funds" {
		t.Fatalf("lifecycle %s", lc)
	}
	// Account funded, relayer empty.
	re.chain.balances[re.chain.account] = new(big.Int).Mul(big.NewInt(2), big.NewInt(1e18))
	re.chain.balances[re.relay] = big.NewInt(1000)
	ex = re.run(3)
	if ex.Stage != store.ExecStageRelayerFunds || len(re.chain.sent) != 0 || !strings.Contains(ex.LastError, re.relay.Hex()) {
		t.Fatalf("relayer funds: %s %q sent=%d", ex.Stage, ex.LastError, len(re.chain.sent))
	}
	if lc := re.lifecycle(); lc != "insufficient_relayer_funds" {
		t.Fatalf("lifecycle %s", lc)
	}
	re.chain.balances[re.relay] = big.NewInt(1e18)
	if ex = re.run(100); ex.Status != store.ExecConfirmed {
		t.Fatalf("after funding: %s %q", ex.Status, ex.LastError)
	}
}

func TestRelayerResumesPartialSetup(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	// Verifier and factory already deployed (by anyone), 6 of 20 matrix entries expanded,
	// and entry 7 alone (its pair 6-7 is still incomplete).
	re.chain.code[qdaccount.VerifierAddress()], re.chain.code[qdaccount.FactoryAddress()] = true, true
	for _, i := range []int{0, 1, 2, 3, 4, 5, 7} {
		re.chain.entries[i] = true
	}
	ex := re.run(100)
	if ex.Status != store.ExecConfirmed {
		t.Fatalf("%s %q", ex.Status, ex.LastError)
	}
	// Pairs 6-7 … 18-19 (7) + account = 8 setup transactions; nothing completed is repeated.
	if len(ex.SetupTxs) != 8 || len(re.chain.sent) != 9 {
		t.Fatalf("setup txs %d sent %d", len(ex.SetupTxs), len(re.chain.sent))
	}
}

func TestRelayerSetupSurvivesRestartWithTransactionInFlight(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	re.chain.autoMine = false
	re.run(1) // sends the verifier deployment, not mined
	ex := re.execID()
	if ex.PendingSetupTx == "" || len(re.chain.sent) != 1 || ex.Stage != store.ExecStageSettingUpVerifier {
		t.Fatalf("in flight: %+v", ex)
	}
	// A restarted relayer (fresh process state) must wait for it, not send it again.
	re.r = NewRelayer(re.st, re.r.chains, re.r.keys, nil)
	re.r.now = func() time.Time { return re.clock }
	for i := 0; i < 5; i++ {
		re.clock = re.clock.Add(5 * time.Second)
		if err := re.r.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(re.chain.sent) != 1 {
		t.Fatalf("resent an in-flight setup transaction: %d", len(re.chain.sent))
	}
	re.chain.autoMine = true
	re.chain.mine()
	if ex = re.run(100); ex.Status != store.ExecConfirmed || len(ex.SetupTxs) != 13 {
		t.Fatalf("%s %d", ex.Status, len(ex.SetupTxs))
	}
}

func TestRelayerRevertedSetupBacksOffAndGivesUp(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	re.chain.revertNth[1], re.chain.revertNth[2], re.chain.revertNth[3] = true, true, true
	start := re.clock
	if err := re.r.ProcessOnce(ctx); err != nil { // send #1
		t.Fatal(err)
	}
	re.clock = re.clock.Add(3 * time.Second)
	if err := re.r.ProcessOnce(ctx); err != nil { // sees the revert
		t.Fatal(err)
	}
	ex := re.execID()
	if ex.SetupAttempts != 1 || ex.NextAttemptAt == nil || ex.NextAttemptAt.Sub(re.clock) != 5*time.Minute {
		t.Fatalf("first revert: attempts %d next %v", ex.SetupAttempts, ex.NextAttemptAt)
	}
	// No rapid retries: many passes within the delay send nothing.
	for i := 0; i < 20; i++ {
		re.clock = re.clock.Add(10 * time.Second)
		_ = re.r.ProcessOnce(ctx)
	}
	if len(re.chain.sent) != 1 {
		t.Fatalf("retried within the delay: %d sent", len(re.chain.sent))
	}
	ex = re.run(20)
	if ex.Status != store.ExecFailed || ex.SetupAttempts != 3 || len(re.chain.sent) != 3 || !strings.Contains(ex.LastError, "gave up") {
		t.Fatalf("give up: %s attempts=%d sent=%d %q", ex.Status, ex.SetupAttempts, len(re.chain.sent), ex.LastError)
	}
	if re.clock.Sub(start) < 10*time.Minute {
		t.Fatal("three attempts must span at least two retry delays")
	}
	if lc := re.lifecycle(); lc != "execution_failed" {
		t.Fatalf("lifecycle %s", lc)
	}
}

func TestRelayerNeverSubmitsTwice(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	re.chain.code[qdaccount.VerifierAddress()], re.chain.code[qdaccount.FactoryAddress()], re.chain.code[re.chain.account] = true, true, true
	for i := 0; i < 20; i++ {
		re.chain.entries[i] = true
	}
	re.chain.autoMine = false
	re.run(1)
	ex := re.execID()
	if ex.Status != store.ExecSubmitted || ex.TxHash == "" || len(re.chain.sent) != 1 || ex.TxNonce == nil {
		t.Fatalf("submitted: %+v", ex)
	}
	if lc := re.lifecycle(); lc != "submitted" {
		t.Fatalf("lifecycle %s", lc)
	}
	hash := ex.TxHash
	// Repeated passes (and a second relayer instance) never sign another execute transaction.
	other := NewRelayer(re.st, re.r.chains, re.r.keys, nil)
	other.now = re.r.now
	for i := 0; i < 10; i++ {
		_ = re.r.ProcessOnce(ctx)
		_ = other.ProcessOnce(ctx)
	}
	re.clock = re.clock.Add(3 * time.Minute) // rebroadcast interval: the same bytes, same hash
	_ = re.r.ProcessOnce(ctx)
	for _, s := range re.chain.sent {
		if strings.ToLower(s.Hash().Hex()) != hash {
			t.Fatal("a second, different execute transaction was sent")
		}
	}
	re.chain.mine()
	if ex = re.run(3); ex.Status != store.ExecConfirmed || ex.TxHash != hash {
		t.Fatalf("%s %s", ex.Status, ex.TxHash)
	}
}

func TestRelayerNonceExpiryAndSimulation(t *testing.T) {
	t.Run("nonce already used", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.code[re.chain.account] = true
		re.chain.nonce = 1
		ex := re.run(3)
		if ex.Status != store.ExecFailed || !strings.Contains(ex.LastError, "already used") {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
		for _, s := range re.chain.sent {
			if *s.To() == re.chain.account {
				t.Fatal("execute sent for a used nonce")
			}
		}
	})
	t.Run("expired", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.clock = re.prop.ExpiresAt.Add(time.Second)
		ex := re.run(1)
		if ex.Status != store.ExecFailed || ex.Stage != store.ExecStageExpired || len(re.chain.sent) != 0 {
			t.Fatalf("%s %s sent=%d", ex.Status, ex.Stage, len(re.chain.sent))
		}
		if lc := re.lifecycle(); lc != "expired" {
			t.Fatalf("lifecycle %s", lc)
		}
	})
	t.Run("simulation reverts (e.g. replayed or invalid signature)", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.failCalls = true
		ex := re.run(100)
		if ex.Status != store.ExecFailed || !strings.Contains(ex.LastError, "nothing was sent") {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
		for _, s := range re.chain.sent {
			if *s.To() == re.chain.account {
				t.Fatal("execute was broadcast after a failed simulation")
			}
		}
	})
	t.Run("wrong account code", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.code[re.chain.account], re.chain.wrongPK = true, true
		if ex := re.run(3); ex.Status != store.ExecFailed || !strings.Contains(ex.LastError, "not the expected QdAccount") {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
	})
}

func TestRelayerReceiptVerification(t *testing.T) {
	t.Run("event reports another destination", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.alterTo = true
		if ex := re.run(100); ex.Status != store.ExecFailed || !strings.Contains(ex.LastError, "does not match the approved proposal") {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
	})
	t.Run("inner call reverted", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.innerFail = true
		ex := re.run(100)
		if ex.Status != store.ExecFailed || ex.CallSuccess == nil || *ex.CallSuccess || ex.TxHash == "" {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
		if re.lifecycle() != "execution_failed" {
			t.Fatal("must not show confirmed")
		}
	})
	t.Run("execute transaction reverted", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.revertNth[14] = true // after 13 setup transactions
		if ex := re.run(100); ex.Status != store.ExecFailed || !strings.Contains(ex.LastError, "reverted on chain") {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
	})
	t.Run("node rejects for insufficient funds", func(t *testing.T) {
		re := newRelayerEnv(t)
		re.fund()
		re.chain.code[qdaccount.VerifierAddress()], re.chain.code[qdaccount.FactoryAddress()], re.chain.code[re.chain.account] = true, true, true
		for i := 0; i < 20; i++ {
			re.chain.entries[i] = true
		}
		re.chain.rejectRaw = "insufficient funds for gas * price + value"
		ex := re.run(1)
		if ex.Status != store.ExecPending || ex.Stage != store.ExecStageRelayerFunds || ex.TxHash != "" {
			t.Fatalf("%s %s %q", ex.Status, ex.Stage, ex.TxHash)
		}
		re.chain.rejectRaw = ""
		if ex = re.run(10); ex.Status != store.ExecConfirmed {
			t.Fatalf("%s %q", ex.Status, ex.LastError)
		}
	})
}

func TestParseRelayerKeys(t *testing.T) {
	k, _ := crypto.GenerateKey()
	hexKey := hexutil.Encode(crypto.FromECDSA(k))
	got, err := ParseRelayerKeys(map[int64]string{11155111: hexKey})
	if err != nil || crypto.PubkeyToAddress(got[11155111].PublicKey) != crypto.PubkeyToAddress(k.PublicKey) {
		t.Fatalf("valid key: %v", err)
	}
	_, err = ParseRelayerKeys(map[int64]string{11155111: "0x1234"})
	if err == nil || !strings.Contains(err.Error(), "RELAYER_PRIVATE_KEY_11155111") || strings.Contains(err.Error(), "1234") {
		t.Fatalf("invalid key error must name the variable and not echo the value: %v", err)
	}
}

func TestGasLimitAndSanitize(t *testing.T) {
	if g, err := gasLimitFor(33_000_000, 60_000_000, 60_000_000); err != nil || g != 39_600_000 {
		t.Fatalf("Amsterdam matrix pair: %d %v", g, err)
	}
	if g, _ := gasLimitFor(24_000_000, 30_000_000, 60_000_000); g != 28_800_000 {
		t.Fatalf("verifier deploy: %d", g)
	}
	if g, _ := gasLimitFor(29_000_000, 30_000_000, 60_000_000); g != 30_000_000 {
		t.Fatalf("capped at block gas limit: %d", g)
	}
	if _, err := gasLimitFor(70_000_000, 200_000_000, 60_000_000); err == nil {
		t.Fatal("runaway estimate accepted")
	}
	if s := sanitize("Post https://eth-sepolia.g.alchemy.com/v2/abc123: timeout"); strings.Contains(s, "abc123") {
		t.Fatal(s)
	}
}

func TestRelayerStatusReportsConfiguration(t *testing.T) {
	re := newRelayerEnv(t)
	re.chain.balances[re.relay] = big.NewInt(42)
	re.r.ChainIDs = []int64{re.prop.ChainID, 84532}
	st := re.r.Status(ctx)
	if len(st) != 2 {
		t.Fatalf("%+v", st)
	}
	a := st[0]
	if a.ChainID != re.prop.ChainID || !a.RPCOK || !a.RelayerConfigured || a.RelayerAddress != re.relay.Hex() || a.RelayerBalanceWei != "42" ||
		a.VerifierDeployed == nil || *a.VerifierDeployed || a.DeployerPresent == nil || !*a.DeployerPresent {
		t.Fatalf("%+v", a)
	}
	b := st[1]
	if b.RelayerConfigured || b.Ready || len(b.Problems) == 0 {
		t.Fatalf("%+v", b)
	}
	raw, _ := json.Marshal(st)
	if strings.Contains(strings.ToLower(string(raw)), strings.ToLower(hexutil.Encode(crypto.FromECDSA(re.key))[2:])) {
		t.Fatal("private key in status")
	}
}

// signAnother approves and signs a second proposal for the same account
// (same account nonce: neither has executed yet).
func (re *relayerEnv) signAnother() *store.Proposal {
	re.t.Helper()
	prop := re.propose(re.prop.WalletID, re.users[0], re.prop.AccountID)
	for _, u := range re.users[:prop.RequiredApprovals] {
		re.ok(re.vote(u, prop, store.VoteApprove))
	}
	v := must(re.svc.StartSigning(ctx, re.users[0].p, prop.ID))
	sw := re.st.SharedWallets()
	for round := 1; round <= 3; round++ {
		for i, idx := range v.Session.Act {
			if _, err := sw.AddSigningMessage(ctx, &store.SigningMessage{SessionID: v.Session.ID, Round: round, PartyIndex: idx,
				MemberID: v.Session.SignerMemberIDs[i], Payload: []byte{1}, DeviceSignature: []byte{1}}, re.clock, nil); err != nil {
				re.t.Fatal(err)
			}
		}
	}
	if _, err := sw.CompleteSigningSession(ctx, v.Session.ID, make([]byte, qdraccoon.SignatureBytes), re.clock); err != nil {
		re.t.Fatal(err)
	}
	return must(sw.GetProposal(ctx, prop.ID))
}

// Seen on public Sepolia: two approved proposals for one account, both at
// account nonce 0, were submitted in the same block; the second reverted
// (BadNonce) and still cost gas. Only one execute per account may be in flight.
func TestRelayerOneExecuteInFlightPerAccount(t *testing.T) {
	re := newRelayerEnv(t)
	re.fund()
	second := re.signAnother()
	if second.Nonce != re.prop.Nonce {
		t.Fatalf("test needs equal nonces: %d vs %d", second.Nonce, re.prop.Nonce)
	}
	sw := re.st.SharedWallets()
	executes := func() int {
		n := 0
		for _, tx := range re.chain.sent {
			if *tx.To() == re.chain.account {
				n++
			}
		}
		return n
	}
	// Setup mines immediately; the first execute stays in the mempool.
	re.chain.holdExecutes = true
	for i := 0; i < 100 && executes() == 0; i++ {
		if err := re.r.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		re.clock = re.clock.Add(time.Minute)
	}
	if executes() != 1 || len(re.chain.pending) != 1 {
		t.Fatalf("executes after setup: %d (pending %d)", executes(), len(re.chain.pending))
	}
	for i := 0; i < 5; i++ {
		if err := re.r.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		re.clock = re.clock.Add(time.Minute)
	}
	if executes() != 1 {
		t.Fatalf("a second execute for the same account was sent while the first was in flight: %d", executes())
	}
	var waiting *store.Execution
	for _, id := range []uuid.UUID{re.prop.ID, second.ID} {
		if ex := must(sw.GetExecution(ctx, id)); ex.Status == store.ExecPending {
			waiting = ex
		}
	}
	if waiting == nil || waiting.Stage != store.ExecStageWaitingNonce || !strings.Contains(waiting.LastError, "in-flight transaction") {
		t.Fatalf("the other proposal should wait: %+v", waiting)
	}
	// Mine: one confirms; the other then fails its nonce check without sending anything.
	// The fake emits Executed for chain.call: point it at whichever proposal is in flight.
	for _, pr := range []*store.Proposal{re.prop, second} {
		if ex := must(sw.GetExecution(ctx, pr.ID)); ex.Status == store.ExecSubmitted {
			ss, _, err := sw.GetSigningSession(ctx, ex.SessionID, re.clock)
			if err != nil {
				t.Fatal(err)
			}
			re.chain.call = must(ProposalCall(pr))
			copy(re.chain.message[:], ss.Message)
		}
	}
	re.chain.holdExecutes = false
	re.chain.mine()
	for i := 0; i < 10; i++ {
		if err := re.r.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		re.clock = re.clock.Add(time.Minute)
	}
	a, b := must(sw.GetExecution(ctx, re.prop.ID)), must(sw.GetExecution(ctx, second.ID))
	statuses := map[store.ExecutionStatus]int{a.Status: 1}
	statuses[b.Status]++
	if statuses[store.ExecConfirmed] != 1 || statuses[store.ExecFailed] != 1 || executes() != 1 {
		t.Fatalf("outcome: %s/%s, executes %d", a.Status, b.Status, executes())
	}
	failed := a
	if b.Status == store.ExecFailed {
		failed = b
	}
	if !strings.Contains(failed.LastError, "already used") {
		t.Fatalf("failure reason: %q", failed.LastError)
	}
}
