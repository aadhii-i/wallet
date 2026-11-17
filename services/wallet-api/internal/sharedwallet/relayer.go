package sharedwallet

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/qdraccoon"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Relayer submits verified shared-wallet signatures to their QdAccount.
//
// It holds only a gas-paying EOA key per chain. That key cannot move a
// shared account's funds: QdAccount executes nothing without a valid
// Raccoon signature over the exact call. The relayer can delay or refuse to
// submit (censor), not redirect. Anyone else could submit the same signed
// call; the relayer is a convenience.
//
// Each pass advances every execution by at most one on-chain step and
// persists it (the setup transaction it sent, the execute transaction before
// broadcasting it), so a restart resumes where it stopped and never repeats a
// paid transaction that already succeeded. Chain state is re-read every pass
// and is the source of truth for what setup is still missing.
//
// One relayer goroutine per API instance; several API instances sharing one
// relayer key are not supported.

type ChainCaller interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
}

type Relayer struct {
	store  store.Store
	chains func(chainID int64) (ChainCaller, bool)
	keys   map[int64]*ecdsa.PrivateKey
	logger *slog.Logger
	now    func() time.Time
	// ChainIDs lists chains with an RPC upstream, for diagnostics.
	ChainIDs     []int64
	PollInterval time.Duration
	Rebroadcast  time.Duration
	// RetryWait spaces re-checks while waiting for funding, configuration or an earlier nonce.
	RetryWait time.Duration
	// SimulateGas is the gas given to eth_call simulations of execute (~11M
	// needed); it stays under the EIP-7825 per-transaction cap.
	SimulateGas uint64
	// MaxGas is an absolute ceiling on a relayer transaction's gas limit (it
	// is also capped at the block gas limit). It is not the EIP-7825 cap:
	// since Amsterdam (EIP-8037) state-creation gas is charged outside that
	// cap, so one-time setup transactions that store code (verifier ~24M,
	// two matrix entries ~33M on Sepolia) legitimately exceed 16.78M. The
	// node's estimate is what decides; this only bounds a runaway estimate.
	MaxGas uint64
	// SetupRevertLimit is how many on-chain reverts of setup transactions an
	// execution tolerates before it is failed; retries are SetupRetryDelay apart.
	SetupRevertLimit int
	SetupRetryDelay  time.Duration
	// LowBalanceWei optionally overrides, per chain, the balance below which
	// the gas service account is reported as low (GAS_LOW_BALANCE_WEI_<id>).
	LowBalanceWei map[int64]*big.Int
	// Monitor, if running, records the gas service account's history.
	Monitor *GasMonitor

	mu        sync.Mutex
	logged    map[string]string // last logged stage message per proposal (avoids log spam)
	setupBusy map[int64]bool    // chains with a setup transaction in flight (rebuilt each pass)
	// execBusy: "chain/account" → hash of an execute transaction in flight
	// (rebuilt each pass). Two proposals for one account may carry the same
	// account nonce; both would pass simulation against the pre-block state,
	// so only one execute per account is ever in flight — the other then
	// fails its nonce check without spending gas.
	execBusy map[string]string
}

// Gas upper bounds used only to check that the relayer can afford the
// remaining work before it spends anything (measured under Amsterdam, the
// most expensive rules; ×1.2 limit headroom is applied on top).
const (
	gasBoundDeployVerifier = 25_000_000
	gasBoundDeployFactory  = 5_500_000
	gasBoundMatrixPair     = 34_000_000
	gasBoundCreateAccount  = 4_000_000
	gasBoundExecute        = 12_000_000
)

func NewRelayer(st store.Store, chains func(int64) (ChainCaller, bool), keys map[int64]*ecdsa.PrivateKey, logger *slog.Logger) *Relayer {
	if logger == nil {
		logger = slog.Default()
	}
	return &Relayer{
		store: st, chains: chains, keys: keys, logger: logger, now: time.Now,
		PollInterval: 2 * time.Second, Rebroadcast: 2 * time.Minute, RetryWait: 20 * time.Second,
		SimulateGas: 16_000_000, MaxGas: 60_000_000, SetupRevertLimit: 3, SetupRetryDelay: 5 * time.Minute,
		logged: map[string]string{}, setupBusy: map[int64]bool{}, execBusy: map[string]string{}, LowBalanceWei: map[int64]*big.Int{},
	}
}

// RelayerAddress returns the gas payer for a chain, if configured.
func (r *Relayer) RelayerAddress(chainID int64) (common.Address, bool) {
	k, ok := r.keys[chainID]
	if !ok {
		return common.Address{}, false
	}
	return crypto.PubkeyToAddress(k.PublicKey), true
}

func (r *Relayer) Run(ctx context.Context) {
	t := time.NewTicker(r.PollInterval)
	defer t.Stop()
	for {
		if err := r.ProcessOnce(ctx); err != nil && ctx.Err() == nil {
			r.logger.Warn("relayer pass failed", "err", sanitize(err.Error()))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ProcessOnce advances every pending or submitted execution by one step.
func (r *Relayer) ProcessOnce(ctx context.Context) error {
	execs, err := r.store.SharedWallets().ListExecutions(ctx, []store.ExecutionStatus{store.ExecPending, store.ExecSubmitted})
	if err != nil {
		return err
	}
	busy := map[int64]bool{}
	inflight := map[string]string{}
	for _, e := range execs {
		if e.PendingSetupTx != "" {
			busy[e.ChainID] = true
		}
		if e.Status == store.ExecSubmitted && e.TxHash != "" {
			inflight[execKey(e.ChainID, e.AccountAddress)] = e.TxHash
		}
	}
	r.mu.Lock()
	r.setupBusy = busy
	r.execBusy = inflight
	r.mu.Unlock()
	for _, e := range execs {
		switch e.Status {
		case store.ExecPending:
			if e.NextAttemptAt != nil && r.now().Before(*e.NextAttemptAt) {
				continue
			}
			r.submit(ctx, e)
		case store.ExecSubmitted:
			r.track(ctx, e)
		}
	}
	return nil
}

type execContext struct {
	e       *store.Execution
	prop    *store.Proposal
	session *store.SigningSession
	pk      []byte
	pkHash  [32]byte
	seedA   [32]byte
	call    *qdaccount.Call
	account common.Address
	chain   ChainCaller
	key     *ecdsa.PrivateKey
	from    common.Address
}

func (r *Relayer) load(ctx context.Context, e *store.Execution) (*execContext, error) {
	sw := r.store.SharedWallets()
	prop, err := sw.GetProposal(ctx, e.ProposalID)
	if err != nil {
		return nil, err
	}
	ss, _, err := sw.GetSigningSession(ctx, e.SessionID, r.now())
	if err != nil {
		return nil, err
	}
	if ss.Status != store.SigningComplete || len(ss.Signature) != qdraccoon.SignatureBytes {
		return nil, errors.New("signing session has no verified signature")
	}
	key, err := sw.GetAccountKey(ctx, prop.AccountID, ss.KeygenID)
	if err != nil {
		return nil, err
	}
	call, err := ProposalCall(prop)
	if err != nil {
		return nil, err
	}
	x := &execContext{e: e, prop: prop, session: ss, pk: key.PublicKey, call: call, account: common.HexToAddress(e.AccountAddress)}
	copy(x.pkHash[:], key.PublicKeyHash)
	copy(x.seedA[:], key.PublicKey[:32])
	// The signed message must be exactly the call we are about to submit,
	// from exactly this account: the relayer cannot alter either.
	if qdaccount.AccountAddress(x.pkHash) != x.account || !strings.EqualFold(key.Address, e.AccountAddress) {
		return nil, errors.New("execution account is not CREATE2(factory, H(pk))")
	}
	msg := qdaccount.ExecutionMessage(big.NewInt(prop.ChainID), x.account, call)
	if string(msg[:]) != string(ss.Message) {
		return nil, errors.New("execution does not match the signed message")
	}
	return x, nil
}

// set moves an execution from `from` to `to`; a conflict means someone else moved it.
func (r *Relayer) set(ctx context.Context, e *store.Execution, from, to store.ExecutionStatus, stage, msg string) {
	msg = sanitize(msg)
	e.Status, e.Stage, e.LastError, e.UpdatedAt = to, stage, msg, r.now()
	if err := r.store.SharedWallets().UpdateExecution(ctx, e, from); err != nil {
		r.logger.Warn("relayer: execution update failed", "proposal", e.ProposalID, "err", err)
		return
	}
	key := e.ProposalID.String()
	r.mu.Lock()
	changed := r.logged[key] != stage+"|"+msg
	r.logged[key] = stage + "|" + msg
	r.mu.Unlock()
	switch {
	case to == store.ExecFailed || to == store.ExecConfirmed:
		r.logger.Info("relayer: execution finished", "proposal", e.ProposalID, "status", to, "tx", e.TxHash, "reason", msg)
	case changed:
		r.logger.Info("relayer: execution progress", "proposal", e.ProposalID, "chain", e.ChainID, "stage", stage, "detail", msg)
	}
}

// wait returns a claimed execution to pending until `after` from now.
func (r *Relayer) wait(ctx context.Context, e *store.Execution, stage, msg string, after time.Duration) {
	t := r.now().Add(after)
	e.NextAttemptAt = &t
	r.set(ctx, e, store.ExecSubmitting, store.ExecPending, stage, msg)
}

func (r *Relayer) fail(ctx context.Context, e *store.Execution, from store.ExecutionStatus, stage, msg string) {
	e.NextAttemptAt = nil
	r.set(ctx, e, from, store.ExecFailed, stage, msg)
}

func (r *Relayer) submit(ctx context.Context, e *store.Execution) {
	claimed := *e
	claimed.Status, claimed.UpdatedAt = store.ExecSubmitting, r.now()
	if claimed.PendingSetupTx == "" {
		claimed.Stage = store.ExecStageCheckingRelayer
	}
	if err := r.store.SharedWallets().UpdateExecution(ctx, &claimed, store.ExecPending); err != nil {
		return // another worker took it
	}
	e = &claimed
	x, err := r.load(ctx, e)
	if err != nil {
		r.fail(ctx, e, store.ExecSubmitting, store.ExecStageFailed, "invalid execution: "+err.Error())
		return
	}
	if !r.now().Before(time.Unix(x.call.ValidUntil.Int64(), 0)) {
		r.fail(ctx, e, store.ExecSubmitting, store.ExecStageExpired,
			fmt.Sprintf("the proposal expired at %s before it could be executed; nothing was submitted", time.Unix(x.call.ValidUntil.Int64(), 0).UTC().Format(time.RFC3339)))
		return
	}
	if msg := r.attach(ctx, x); msg != "" {
		r.wait(ctx, e, store.ExecStageRelayerUnavailable, msg, r.RetryWait)
		return
	}
	e.RelayerAddress = strings.ToLower(x.from.Hex())

	// A setup transaction from an earlier pass: resolve it before anything else.
	if e.PendingSetupTx != "" {
		state, err := r.txState(ctx, x.chain, e.PendingSetupTx)
		switch {
		case err != nil:
			r.wait(ctx, e, e.Stage, "checking setup transaction "+e.PendingSetupTx+": "+err.Error(), 5*time.Second)
			return
		case state == txPending:
			r.wait(ctx, e, setupStage(e.Stage), "waiting for setup transaction "+e.PendingSetupTx+" to be mined", 3*time.Second)
			return
		case state == txSuccess:
			r.logger.Info("relayer: setup transaction mined", "proposal", e.ProposalID, "chain", e.ChainID, "tx", e.PendingSetupTx)
			e.SetupTxs = append(e.SetupTxs, e.PendingSetupTx)
			e.PendingSetupTx = ""
			r.clearBusy(x.prop.ChainID)
		case state == txDropped:
			e.PendingSetupTx = "" // never mined; chain state decides what to resend
			r.clearBusy(x.prop.ChainID)
		case state == txReverted:
			r.clearBusy(x.prop.ChainID)
			hash := e.PendingSetupTx
			e.PendingSetupTx = ""
			e.SetupAttempts++
			if e.SetupAttempts >= r.SetupRevertLimit {
				r.fail(ctx, e, store.ExecSubmitting, store.ExecStageFailed,
					fmt.Sprintf("setup transaction %s reverted on chain; gave up after %d reverted setup transactions", hash, e.SetupAttempts))
				return
			}
			r.wait(ctx, e, setupStage(e.Stage), fmt.Sprintf("setup transaction %s reverted on chain (attempt %d of %d); retrying in %s",
				hash, e.SetupAttempts, r.SetupRevertLimit, r.SetupRetryDelay), r.SetupRetryDelay)
			return
		}
	}

	pre, err := r.preflight(ctx, x)
	if err != nil {
		r.wait(ctx, e, store.ExecStageCheckingRelayer, "reading chain state: "+err.Error(), r.RetryWait)
		return
	}
	if pre.fatal != "" {
		r.fail(ctx, e, store.ExecSubmitting, store.ExecStageFailed, pre.fatal)
		return
	}
	if pre.waitStage != "" {
		r.wait(ctx, e, pre.waitStage, pre.waitMsg, r.RetryWait)
		return
	}

	if len(pre.steps) > 0 {
		r.mu.Lock()
		busy := r.setupBusy[x.prop.ChainID]
		r.mu.Unlock()
		if busy {
			r.wait(ctx, e, pre.steps[0].stage, "waiting for another proposal's setup transaction on this chain", 3*time.Second)
			return
		}
		step := pre.steps[0]
		tx, err := r.signTx(ctx, x, step.to, step.data, pre.fees)
		if err != nil {
			r.wait(ctx, e, step.stage, step.label+": could not prepare transaction: "+err.Error(), r.RetryWait)
			return
		}
		raw, _ := tx.MarshalBinary()
		// Persist before broadcasting: after a crash the next pass finds it.
		e.PendingSetupTx = strings.ToLower(tx.Hash().Hex())
		e.Stage, e.LastError, e.UpdatedAt = step.stage, sanitize(fmt.Sprintf("%s (step 1 of %d remaining): sent %s", step.label, len(pre.steps), e.PendingSetupTx)), r.now()
		if err := r.store.SharedWallets().UpdateExecution(ctx, e, store.ExecSubmitting); err != nil {
			r.logger.Warn("relayer: could not record setup transaction", "err", err)
			return
		}
		r.mu.Lock()
		r.setupBusy[x.prop.ChainID] = true
		r.mu.Unlock()
		if _, err := x.chain.Call(ctx, "eth_sendRawTransaction", []any{hexutil.Encode(raw)}); err != nil && !strings.Contains(err.Error(), "already known") {
			e.PendingSetupTx = ""
			r.wait(ctx, e, step.stage, step.label+": broadcast failed: "+err.Error(), r.RetryWait)
			return
		}
		r.wait(ctx, e, step.stage, fmt.Sprintf("%s: sent %s (%d setup transaction(s) left including this one)", step.label, strings.ToLower(tx.Hash().Hex()), len(pre.steps)), 3*time.Second)
		return
	}

	// Setup complete and the account is at this proposal's nonce: execute,
	// unless another execute for this account is still in flight.
	r.mu.Lock()
	other := r.execBusy[execKey(x.prop.ChainID, e.AccountAddress)]
	r.mu.Unlock()
	if other != "" && !strings.EqualFold(other, e.TxHash) {
		r.wait(ctx, e, store.ExecStageWaitingNonce, "waiting for this account's in-flight transaction "+other+" to be mined before submitting", 3*time.Second)
		return
	}
	data, err := qdaccount.ExecuteCalldata(x.call, x.pk, x.session.Signature)
	if err != nil {
		r.fail(ctx, e, store.ExecSubmitting, store.ExecStageFailed, "calldata: "+err.Error())
		return
	}
	// Simulate first: a revert here (bad signature, wrong nonce, expiry) must not cost gas.
	if _, err := r.ethCall(ctx, x, x.account, data); err != nil {
		r.fail(ctx, e, store.ExecSubmitting, store.ExecStageFailed, "simulation of execute reverted, nothing was sent: "+err.Error())
		return
	}
	tx, err := r.signTx(ctx, x, x.account, data, pre.fees)
	if err != nil {
		r.wait(ctx, e, store.ExecStageSubmitting, "could not prepare the execute transaction: "+err.Error(), r.RetryWait)
		return
	}
	raw, _ := tx.MarshalBinary()
	now := r.now()
	n := tx.Nonce()
	e.TxHash, e.RawTx, e.SubmittedAt, e.TxNonce = strings.ToLower(tx.Hash().Hex()), raw, &now, &n
	// Persist before broadcasting, so a crash can only lead to rebroadcasting the same transaction.
	e.Status, e.Stage, e.LastError, e.UpdatedAt, e.NextAttemptAt = store.ExecSubmitted, store.ExecStageSubmitted, "", now, nil
	if err := r.store.SharedWallets().UpdateExecution(ctx, e, store.ExecSubmitting); err != nil {
		r.logger.Warn("relayer: could not record transaction", "err", err)
		return
	}
	r.mu.Lock()
	r.execBusy[execKey(x.prop.ChainID, e.AccountAddress)] = e.TxHash
	r.mu.Unlock()
	if _, err := x.chain.Call(ctx, "eth_sendRawTransaction", []any{hexutil.Encode(raw)}); err != nil && !strings.Contains(err.Error(), "already known") {
		if isDefinitiveRejection(err) {
			// The node refused it outright: nothing is in flight. Re-sign later.
			e.TxHash, e.RawTx, e.SubmittedAt, e.TxNonce = "", nil, nil, nil
			stage := store.ExecStageSubmitting
			if strings.Contains(strings.ToLower(err.Error()), "insufficient funds") {
				stage = store.ExecStageRelayerFunds
			}
			t := r.now().Add(r.RetryWait)
			e.NextAttemptAt = &t
			r.set(ctx, e, store.ExecSubmitted, store.ExecPending, stage, "the node rejected the execute transaction: "+err.Error())
			return
		}
		// Unknown outcome (timeout etc.): keep the recorded transaction; track() rebroadcasts the same bytes.
		r.set(ctx, e, store.ExecSubmitted, store.ExecSubmitted, store.ExecStageSubmitted, "broadcast outcome unknown, will rebroadcast the same transaction: "+err.Error())
		return
	}
	r.logger.Info("relayer: submitted", "proposal", e.ProposalID, "tx", e.TxHash, "account", e.AccountAddress, "relayer", e.RelayerAddress)
}

// attach resolves the chain's RPC and relayer key and checks the RPC's chain
// id. It returns a human-readable reason when the chain cannot be used.
func (r *Relayer) attach(ctx context.Context, x *execContext) string {
	id := x.prop.ChainID
	var ok bool
	if x.chain, ok = r.chains(id); !ok {
		return fmt.Sprintf("no RPC configured for chain %d: set EVM_RPC_%d in the API environment and restart the API", id, id)
	}
	if x.key, ok = r.keys[id]; !ok {
		return fmt.Sprintf("no relayer configured for chain %d: set RELAYER_PRIVATE_KEY_%d in the API environment (e.g. .env used by make api) and restart the API", id, id)
	}
	x.from = crypto.PubkeyToAddress(x.key.PublicKey)
	got, err := r.quantity(ctx, x.chain, "eth_chainId", []any{})
	if err != nil {
		return fmt.Sprintf("RPC for chain %d is unreachable: %v", id, err)
	}
	if got.Int64() != id {
		return fmt.Sprintf("RPC configured for chain %d reports chain id %s; refusing to submit", id, got)
	}
	return ""
}

type setupStep struct {
	stage string
	label string
	to    common.Address
	data  []byte
	gas   uint64 // upper bound, for the funds check only
}

type feeQuote struct {
	base, tip, feeCap *big.Int
	blockGasLimit     uint64
}

type preflightResult struct {
	steps     []setupStep
	fees      *feeQuote
	fatal     string // the execution can never succeed
	waitStage string // the execution must wait (funding, earlier nonce)
	waitMsg   string
}

// preflight reads chain state and decides the next step: which one-time
// setup is still missing, whether the shared account and the relayer can pay,
// and whether the account is at this proposal's nonce. It sends nothing.
func (r *Relayer) preflight(ctx context.Context, x *execContext) (*preflightResult, error) {
	out := &preflightResult{}
	if dep, err := r.hasCode(ctx, x.chain, qdaccount.Deployer); err != nil {
		return nil, err
	} else if !dep {
		hasV, _ := r.hasCode(ctx, x.chain, qdaccount.VerifierAddress())
		hasF, _ := r.hasCode(ctx, x.chain, qdaccount.FactoryAddress())
		if !hasV || !hasF {
			out.fatal = fmt.Sprintf("the deterministic deployment proxy %s is not on chain %d, so the QD contracts cannot be deployed at their fixed addresses", qdaccount.Deployer.Hex(), x.prop.ChainID)
			return out, nil
		}
	}
	hasVerifier, err := r.hasCode(ctx, x.chain, qdaccount.VerifierAddress())
	if err != nil {
		return nil, err
	}
	if !hasVerifier {
		out.steps = append(out.steps, setupStep{store.ExecStageSettingUpVerifier, "deploying QdRaccoonVerifier (once per chain)",
			qdaccount.Deployer, qdaccount.DeployerCalldata(qdaccount.VerifierInitCode()), gasBoundDeployVerifier})
	}
	hasFactory, err := r.hasCode(ctx, x.chain, qdaccount.FactoryAddress())
	if err != nil {
		return nil, err
	}
	if !hasFactory {
		out.steps = append(out.steps, setupStep{store.ExecStageSettingUpVerifier, "deploying QdAccountFactory (once per chain)",
			qdaccount.Deployer, qdaccount.DeployerCalldata(qdaccount.FactoryInitCode()), gasBoundDeployFactory})
	} else {
		// Phase B: the factory must derive exactly this account address.
		data, _ := qdaccount.FactoryAccountAddressCalldata(x.pkHash)
		got, err := r.ethCall(ctx, x, qdaccount.FactoryAddress(), data)
		if err != nil {
			return nil, err
		}
		if len(got) != 32 || common.BytesToAddress(got) != x.account {
			out.fatal = fmt.Sprintf("factory derives %s for this key, not the registered account %s", common.BytesToAddress(got).Hex(), x.account.Hex())
			return out, nil
		}
	}
	pairs := qdaccount.MatrixEntries / qdaccount.MatrixEntriesPerTx
	for p := 0; p < pairs; p++ {
		first := p * qdaccount.MatrixEntriesPerTx
		missing := !hasVerifier
		for i := first; hasVerifier && !missing && i < first+qdaccount.MatrixEntriesPerTx; i++ {
			data, _ := qdaccount.MatrixEntryCalldata(x.seedA, i)
			got, err := r.ethCall(ctx, x, qdaccount.VerifierAddress(), data)
			if err != nil {
				return nil, err
			}
			missing = len(got) != 32 || common.BytesToAddress(got) == (common.Address{})
		}
		if missing {
			data, _ := qdaccount.ExpandMatrixCalldata(x.seedA, first, qdaccount.MatrixEntriesPerTx)
			out.steps = append(out.steps, setupStep{store.ExecStageSettingUpVerifier,
				fmt.Sprintf("expanding the public matrix for this wallet key, entries %d-%d of %d (once per key per chain)", first, first+qdaccount.MatrixEntriesPerTx-1, qdaccount.MatrixEntries),
				qdaccount.VerifierAddress(), data, gasBoundMatrixPair})
		}
	}
	hasAccount, err := r.hasCode(ctx, x.chain, x.account)
	if err != nil {
		return nil, err
	}
	onchainNonce := big.NewInt(0)
	if hasAccount {
		// Phase B: the code at the address is a QdAccount bound to this verifier and key.
		vd, _ := qdaccount.AccountVerifierCalldata()
		v, err := r.ethCall(ctx, x, x.account, vd)
		if err != nil {
			return nil, err
		}
		hd, _ := qdaccount.AccountPublicKeyHashCalldata()
		h, err := r.ethCall(ctx, x, x.account, hd)
		if err != nil {
			return nil, err
		}
		if len(v) != 32 || common.BytesToAddress(v) != qdaccount.VerifierAddress() || len(h) != 32 || [32]byte(h) != x.pkHash {
			out.fatal = fmt.Sprintf("the code at %s is not the expected QdAccount for this key and verifier", x.account.Hex())
			return out, nil
		}
		nd, _ := qdaccount.NonceCalldata()
		n, err := r.ethCall(ctx, x, x.account, nd)
		if err != nil {
			return nil, err
		}
		onchainNonce.SetBytes(n)
	} else {
		data, _ := qdaccount.CreateAccountCalldata(x.pkHash)
		out.steps = append(out.steps, setupStep{store.ExecStagePreparingAccount, "deploying the shared QdAccount " + x.account.Hex(),
			qdaccount.FactoryAddress(), data, gasBoundCreateAccount})
	}
	switch onchainNonce.Cmp(x.call.Nonce) {
	case 1:
		out.fatal = fmt.Sprintf("account nonce %s was already used (the account is at nonce %s); this proposal can never execute — create a new proposal with nonce %s", x.call.Nonce, onchainNonce, onchainNonce)
		return out, nil
	case -1:
		out.waitStage, out.waitMsg = store.ExecStageWaitingNonce, fmt.Sprintf("waiting for the account to reach nonce %s (it is at %s): an earlier proposal must execute first", x.call.Nonce, onchainNonce)
		return out, nil
	}
	// Funds: never spend relayer gas on setup for a transfer the account cannot pay.
	accBal, err := r.balance(ctx, x.chain, x.account)
	if err != nil {
		return nil, err
	}
	if accBal.Cmp(x.call.Value) < 0 {
		out.waitStage = store.ExecStageAccountFunds
		out.waitMsg = fmt.Sprintf("the shared account %s holds %s ETH but the transfer needs %s ETH; fund the shared account (not the relayer)",
			x.account.Hex(), formatEther(accBal), formatEther(x.call.Value))
		return out, nil
	}
	fees, err := r.fees(ctx, x.chain)
	if err != nil {
		return nil, err
	}
	out.fees = fees
	need := requiredWei(out.steps, fees.feeCap)
	relBal, err := r.balance(ctx, x.chain, x.from)
	if err != nil {
		return nil, err
	}
	if relBal.Cmp(need) < 0 {
		out.waitStage = store.ExecStageRelayerFunds
		out.waitMsg = fmt.Sprintf("the relayer %s holds %s ETH but needs up to %s ETH for %d setup transaction(s) and the execution at the current fee cap of %s wei/gas; fund the relayer",
			x.from.Hex(), formatEther(relBal), formatEther(need), len(out.steps), fees.feeCap)
		return out, nil
	}
	return out, nil
}

func execKey(chainID int64, account string) string {
	return fmt.Sprintf("%d/%s", chainID, strings.ToLower(account))
}

func (r *Relayer) clearBusy(chainID int64) {
	r.mu.Lock()
	r.setupBusy[chainID] = false
	r.mu.Unlock()
}

func setupStage(s string) string {
	if s == store.ExecStagePreparingAccount || s == store.ExecStageSettingUpVerifier {
		return s
	}
	return store.ExecStageSettingUpVerifier
}

func (r *Relayer) track(ctx context.Context, e *store.Execution) {
	chain, ok := r.chains(e.ChainID)
	if !ok {
		return
	}
	raw, err := chain.Call(ctx, "eth_getTransactionReceipt", []any{e.TxHash})
	if err != nil {
		return
	}
	var rc *struct {
		Status            string `json:"status"`
		BlockNumber       string `json:"blockNumber"`
		GasUsed           string `json:"gasUsed"`
		EffectiveGasPrice string `json:"effectiveGasPrice"`
		To                string `json:"to"`
		From              string `json:"from"`
		Logs              []struct {
			Address string   `json:"address"`
			Topics  []string `json:"topics"`
			Data    string   `json:"data"`
		} `json:"logs"`
	}
	if err := json.Unmarshal(raw, &rc); err != nil {
		return
	}
	if rc == nil {
		r.trackPending(ctx, chain, e)
		return
	}
	bn, _ := hexutil.DecodeUint64(rc.BlockNumber)
	gas, _ := hexutil.DecodeUint64(rc.GasUsed)
	e.BlockNumber, e.GasUsed = &bn, &gas
	if p, err := hexutil.DecodeBig(rc.EffectiveGasPrice); err == nil {
		e.EffectiveGasPrice = p.String()
	}
	if t, err := r.blockTime(ctx, chain, rc.BlockNumber); err == nil {
		e.BlockTime = &t
	}
	if rc.Status != "0x1" {
		r.fail(ctx, e, store.ExecSubmitted, store.ExecStageFailed, "the execute transaction reverted on chain (nothing was transferred)")
		return
	}
	if !strings.EqualFold(rc.To, e.AccountAddress) || (e.RelayerAddress != "" && !strings.EqualFold(rc.From, e.RelayerAddress)) {
		r.fail(ctx, e, store.ExecSubmitted, store.ExecStageFailed, "receipt is not a call from the relayer to the shared account")
		return
	}
	ss, _, err := r.store.SharedWallets().GetSigningSession(ctx, e.SessionID, r.now())
	if err != nil {
		return
	}
	prop, err := r.store.SharedWallets().GetProposal(ctx, e.ProposalID)
	if err != nil {
		return
	}
	call, err := ProposalCall(prop)
	if err != nil {
		return
	}
	for _, l := range rc.Logs {
		if !strings.EqualFold(l.Address, e.AccountAddress) {
			continue
		}
		topics := make([]common.Hash, len(l.Topics))
		for i, t := range l.Topics {
			topics[i] = common.HexToHash(t)
		}
		ev, err := qdaccount.DecodeExecuted(topics, common.FromHex(l.Data))
		if err != nil || string(ev.Message[:]) != string(ss.Message) {
			continue
		}
		// The executed operation must be exactly the approved proposal.
		if ev.Nonce.Cmp(call.Nonce) != 0 || ev.To != call.To || ev.Value.Cmp(call.Value) != 0 || ev.ProposalDigest != call.ProposalDigest {
			r.fail(ctx, e, store.ExecSubmitted, store.ExecStageFailed, "the Executed event does not match the approved proposal")
			return
		}
		success := ev.Success
		e.CallSuccess = &success
		e.ExecutedTo, e.ExecutedValue = strings.ToLower(ev.To.Hex()), ev.Value.String()
		if !success {
			r.fail(ctx, e, store.ExecSubmitted, store.ExecStageFailed, "the account executed the call, but the call itself reverted (nonce consumed, no value transferred)")
			return
		}
		now := r.now()
		e.ConfirmedAt = &now
		r.set(ctx, e, store.ExecSubmitted, store.ExecConfirmed, store.ExecStageConfirmed, "")
		return
	}
	r.fail(ctx, e, store.ExecSubmitted, store.ExecStageFailed, "receipt has no matching Executed event from the shared account")
}

// trackPending handles a submitted transaction without a receipt: rebroadcast
// the same bytes now and then; if its relayer nonce was consumed by something
// else, it can never be mined, so the execution returns to pending and is
// re-signed (the account's nonce prevents a double execution).
func (r *Relayer) trackPending(ctx context.Context, chain ChainCaller, e *store.Execution) {
	if e.SubmittedAt == nil || r.now().Sub(*e.SubmittedAt) < r.Rebroadcast {
		return
	}
	known, _ := chain.Call(ctx, "eth_getTransactionByHash", []any{e.TxHash})
	if string(known) == "null" && e.TxNonce != nil && e.RelayerAddress != "" {
		latest, err := r.quantity(ctx, chain, "eth_getTransactionCount", []any{e.RelayerAddress, "latest"})
		if err == nil && latest.Uint64() > *e.TxNonce {
			old := e.TxHash
			e.TxHash, e.RawTx, e.SubmittedAt, e.TxNonce, e.NextAttemptAt = "", nil, nil, nil, nil
			r.set(ctx, e, store.ExecSubmitted, store.ExecPending, store.ExecStageSubmitting, "transaction "+old+" was dropped (its relayer nonce was used by another transaction); re-submitting")
			return
		}
	}
	if len(e.RawTx) > 0 {
		_, _ = chain.Call(ctx, "eth_sendRawTransaction", []any{hexutil.Encode(e.RawTx)})
		now := r.now()
		e.SubmittedAt = &now // next rebroadcast one interval later
		e.UpdatedAt = now
		_ = r.store.SharedWallets().UpdateExecution(ctx, e, store.ExecSubmitted)
	}
}

// ---- diagnostics ---------------------------------------------------------------

// ChainStatus is the relayer's view of one chain. It never contains key material.
type ChainStatus struct {
	ChainID           int64    `json:"chainId"`
	RPCConfigured     bool     `json:"rpcConfigured"`
	RPCOK             bool     `json:"rpcOk"`
	RPCChainID        *int64   `json:"rpcChainId,omitempty"`
	RelayerConfigured bool     `json:"relayerConfigured"`
	RelayerAddress    string   `json:"relayerAddress,omitempty"`
	RelayerBalanceWei string   `json:"relayerBalanceWei,omitempty"`
	DeployerPresent   *bool    `json:"deployerPresent,omitempty"`
	VerifierAddress   string   `json:"verifierAddress"`
	VerifierDeployed  *bool    `json:"verifierDeployed,omitempty"`
	FactoryAddress    string   `json:"factoryAddress"`
	FactoryDeployed   *bool    `json:"factoryDeployed,omitempty"`
	Ready             bool     `json:"ready"`
	Problems          []string `json:"problems"`
	// Funding health, gas prices and capacity (Gas Service Account view).
	*gasFunding
}

// Status reports every chain with an RPC upstream or a relayer key.
func (r *Relayer) Status(ctx context.Context) []ChainStatus {
	ids := map[int64]bool{}
	for _, id := range r.ChainIDs {
		ids[id] = true
	}
	for id := range r.keys {
		ids[id] = true
	}
	var sorted []int64
	for id := range ids {
		sorted = append(sorted, id)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	out := make([]ChainStatus, 0, len(sorted))
	for _, id := range sorted {
		out = append(out, r.chainStatus(ctx, id))
	}
	return out
}

func (r *Relayer) chainStatus(ctx context.Context, id int64) ChainStatus {
	cs := ChainStatus{ChainID: id, VerifierAddress: qdaccount.VerifierAddress().Hex(), FactoryAddress: qdaccount.FactoryAddress().Hex(), Problems: []string{}}
	chain, hasRPC := r.chains(id)
	cs.RPCConfigured = hasRPC
	addr, hasKey := r.RelayerAddress(id)
	cs.RelayerConfigured = hasKey
	if hasKey {
		cs.RelayerAddress = addr.Hex()
	} else {
		cs.Problems = append(cs.Problems, fmt.Sprintf("no relayer key: set RELAYER_PRIVATE_KEY_%d", id))
	}
	if !hasRPC {
		cs.Problems = append(cs.Problems, fmt.Sprintf("no RPC: set EVM_RPC_%d", id))
		return cs
	}
	got, err := r.quantity(ctx, chain, "eth_chainId", []any{})
	if err != nil {
		cs.Problems = append(cs.Problems, "RPC unreachable: "+sanitize(err.Error()))
		return cs
	}
	cs.RPCOK = true
	g := got.Int64()
	cs.RPCChainID = &g
	if g != id {
		cs.Problems = append(cs.Problems, fmt.Sprintf("RPC reports chain id %d, expected %d", g, id))
		return cs
	}
	var relBal *big.Int
	if hasKey {
		if bal, err := r.balance(ctx, chain, addr); err == nil {
			relBal = bal
			cs.RelayerBalanceWei = bal.String()
			if bal.Sign() == 0 {
				cs.Problems = append(cs.Problems, "relayer balance is 0: fund "+addr.Hex()+" to pay gas")
			}
		} else {
			cs.Problems = append(cs.Problems, "relayer balance: "+sanitize(err.Error()))
		}
	}
	b := func(a common.Address) *bool {
		v, err := r.hasCode(ctx, chain, a)
		if err != nil {
			return nil
		}
		return &v
	}
	cs.DeployerPresent, cs.VerifierDeployed, cs.FactoryDeployed = b(qdaccount.Deployer), b(qdaccount.VerifierAddress()), b(qdaccount.FactoryAddress())
	if cs.DeployerPresent != nil && !*cs.DeployerPresent {
		cs.Problems = append(cs.Problems, "deterministic deployment proxy missing on this chain")
	}
	if hasKey {
		deployed := cs.VerifierDeployed != nil && *cs.VerifierDeployed && cs.FactoryDeployed != nil && *cs.FactoryDeployed
		f := r.funding(ctx, id, chain, addr, relBal, deployed)
		cs.gasFunding = &f
	}
	cs.Ready = hasKey && len(cs.Problems) == 0
	return cs
}

// ---- JSON-RPC helpers --------------------------------------------------------

func (r *Relayer) ethCall(ctx context.Context, x *execContext, to common.Address, data []byte) ([]byte, error) {
	out, err := x.chain.Call(ctx, "eth_call", []any{map[string]string{
		"from": x.from.Hex(), "to": to.Hex(), "data": hexutil.Encode(data), "gas": hexutil.EncodeUint64(r.SimulateGas),
	}, "latest"})
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(out, &s); err != nil {
		return nil, err
	}
	return hexutil.Decode(s)
}

func (r *Relayer) hasCode(ctx context.Context, chain ChainCaller, addr common.Address) (bool, error) {
	out, err := chain.Call(ctx, "eth_getCode", []any{addr.Hex(), "latest"})
	if err != nil {
		return false, err
	}
	var s string
	if err := json.Unmarshal(out, &s); err != nil {
		return false, err
	}
	return s != "0x" && s != "", nil
}

func (r *Relayer) balance(ctx context.Context, chain ChainCaller, addr common.Address) (*big.Int, error) {
	return r.quantity(ctx, chain, "eth_getBalance", []any{addr.Hex(), "latest"})
}

func (r *Relayer) quantity(ctx context.Context, chain ChainCaller, method string, params []any) (*big.Int, error) {
	out, err := chain.Call(ctx, method, params)
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(out, &s); err != nil {
		return nil, err
	}
	return hexutil.DecodeBig(s)
}

func (r *Relayer) blockTime(ctx context.Context, chain ChainCaller, number string) (time.Time, error) {
	raw, err := chain.Call(ctx, "eth_getBlockByNumber", []any{number, false})
	if err != nil {
		return time.Time{}, err
	}
	var b *struct {
		Timestamp string `json:"timestamp"`
	}
	if err := json.Unmarshal(raw, &b); err != nil || b == nil {
		return time.Time{}, errors.New("block not found")
	}
	ts, err := hexutil.DecodeUint64(b.Timestamp)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(int64(ts), 0).UTC(), nil
}

// fees quotes EIP-1559 fees from the latest block: fee cap 3× base fee + tip,
// which absorbs a few full blocks of base-fee growth before inclusion.
func (r *Relayer) fees(ctx context.Context, chain ChainCaller) (*feeQuote, error) {
	blockRaw, err := chain.Call(ctx, "eth_getBlockByNumber", []any{"latest", false})
	if err != nil {
		return nil, err
	}
	var block struct {
		BaseFee  string `json:"baseFeePerGas"`
		GasLimit string `json:"gasLimit"`
	}
	if err := json.Unmarshal(blockRaw, &block); err != nil {
		return nil, err
	}
	q := &feeQuote{base: big.NewInt(1_000_000_000)}
	if block.BaseFee != "" {
		if b, err := hexutil.DecodeBig(block.BaseFee); err == nil {
			q.base = b
		}
	}
	q.blockGasLimit, _ = hexutil.DecodeUint64(block.GasLimit)
	tip, err := r.quantity(ctx, chain, "eth_maxPriorityFeePerGas", []any{})
	if err != nil {
		tip = big.NewInt(1_000_000_000)
	}
	q.tip = tip
	q.feeCap = new(big.Int).Add(new(big.Int).Mul(q.base, big.NewInt(3)), tip)
	return q, nil
}

func (r *Relayer) signTx(ctx context.Context, x *execContext, to common.Address, data []byte, q *feeQuote) (*types.Transaction, error) {
	gasEst, err := r.quantity(ctx, x.chain, "eth_estimateGas", []any{map[string]string{
		"from": x.from.Hex(), "to": to.Hex(), "data": hexutil.Encode(data),
	}})
	if err != nil {
		return nil, fmt.Errorf("estimate gas: %w", err)
	}
	if q == nil {
		if q, err = r.fees(ctx, x.chain); err != nil {
			return nil, err
		}
	}
	gas, err := gasLimitFor(gasEst.Uint64(), q.blockGasLimit, r.MaxGas)
	if err != nil {
		return nil, err
	}
	nonce, err := r.quantity(ctx, x.chain, "eth_getTransactionCount", []any{x.from.Hex(), "pending"})
	if err != nil {
		return nil, err
	}
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID: big.NewInt(x.prop.ChainID), Nonce: nonce.Uint64(), GasTipCap: q.tip, GasFeeCap: q.feeCap, Gas: gas, To: &to, Data: data,
	})
	return types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(x.prop.ChainID)), x.key)
}

// gasLimitFor adds 20% headroom to the node's estimate, bounded by the block
// gas limit and the relayer's ceiling.
func gasLimitFor(estimate, blockGasLimit, maxGas uint64) (uint64, error) {
	ceiling := maxGas
	if blockGasLimit > 0 && blockGasLimit < ceiling {
		ceiling = blockGasLimit
	}
	if estimate > ceiling {
		return 0, fmt.Errorf("estimated gas %d exceeds the relayer ceiling %d", estimate, ceiling)
	}
	gas := estimate * 12 / 10
	if gas > ceiling {
		gas = ceiling
	}
	return gas, nil
}

const (
	txPending  = "pending"
	txDropped  = "dropped"
	txSuccess  = "success"
	txReverted = "reverted"
)

func (r *Relayer) txState(ctx context.Context, chain ChainCaller, hash string) (string, error) {
	out, err := chain.Call(ctx, "eth_getTransactionReceipt", []any{hash})
	if err != nil {
		return "", err
	}
	if string(out) != "null" {
		var rc struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(out, &rc); err != nil {
			return "", err
		}
		if rc.Status == "0x1" {
			return txSuccess, nil
		}
		return txReverted, nil
	}
	known, err := chain.Call(ctx, "eth_getTransactionByHash", []any{hash})
	if err != nil {
		return "", err
	}
	if string(known) == "null" {
		return txDropped, nil
	}
	return txPending, nil
}

func isDefinitiveRejection(err error) bool {
	m := strings.ToLower(err.Error())
	for _, s := range []string{"insufficient funds", "nonce too low", "replacement transaction underpriced", "intrinsic gas too low", "exceeds block gas limit", "invalid sender"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

var urlPattern = regexp.MustCompile(`https?://[^\s"']+`)

// sanitize removes URLs (RPC provider URLs carry API keys) from messages
// that are stored, logged or shown to users.
func sanitize(s string) string { return urlPattern.ReplaceAllString(s, "<rpc>") }

// formatEther renders wei as an exact decimal ETH amount (no rounding: a
// requirement of 7,000 gwei must not be shown as 0.000000).
func formatEther(wei *big.Int) string {
	neg := wei.Sign() < 0
	a := new(big.Int).Abs(wei)
	q, r := new(big.Int).QuoRem(a, big.NewInt(1e18), new(big.Int))
	s := q.String()
	if r.Sign() != 0 {
		s += "." + strings.TrimRight(fmt.Sprintf("%018s", r.String()), "0")
	}
	if neg {
		s = "-" + s
	}
	return s
}

// requiredGas is the gas the relayer must be able to pay for the remaining
// setup steps plus the execution: the per-step upper bounds plus the 20 %
// gas-limit headroom applied when transactions are signed.
func requiredGas(steps []setupStep) uint64 {
	var gas uint64 = gasBoundExecute
	for _, s := range steps {
		gas += s.gas
	}
	return gas * 12 / 10
}

// requiredWei is requiredGas at the fee cap: the balance the relayer must
// hold before it starts spending on this execution.
func requiredWei(steps []setupStep, feeCap *big.Int) *big.Int {
	return new(big.Int).Mul(new(big.Int).SetUint64(requiredGas(steps)), feeCap)
}

// ParseRelayerKeys parses RELAYER_PRIVATE_KEY_<chainId> values. Errors name
// the variable but never echo any part of the value.
func ParseRelayerKeys(raw map[int64]string) (map[int64]*ecdsa.PrivateKey, error) {
	out := make(map[int64]*ecdsa.PrivateKey, len(raw))
	for chainID, hexKey := range raw {
		k, err := crypto.HexToECDSA(strings.TrimPrefix(strings.TrimSpace(hexKey), "0x"))
		if err != nil {
			return nil, fmt.Errorf("RELAYER_PRIVATE_KEY_%d is not a valid secp256k1 private key (expected 32 bytes of hex)", chainID)
		}
		out[chainID] = k
	}
	return out, nil
}
