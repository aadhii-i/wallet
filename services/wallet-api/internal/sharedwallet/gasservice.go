package sharedwallet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Gas Service Account: the per-chain relayer EOA that pays gas for
// shared-wallet setup and execution. One account per chain is shared by every
// shared wallet on that chain; its key stays in the API's environment. This
// file adds the read-only views over it — funding health, per-proposal cost
// estimates — built from the same preflight the relayer itself runs, so the
// UI and the relayer never disagree about what is required.

// Health values for a gas service account.
const (
	GasHealthy      = "healthy"
	GasLow          = "low"
	GasInsufficient = "insufficient"
	GasUnknown      = "unknown"
)

// gasFunding is the funding part of ChainStatus (only set when the RPC and
// the relayer key are usable).
type gasFunding struct {
	BlockNumber           *uint64 `json:"blockNumber,omitempty"`
	BaseFeeWei            string  `json:"baseFeeWei,omitempty"`
	TipWei                string  `json:"tipWei,omitempty"`
	GasPriceWei           string  `json:"gasPriceWei,omitempty"` // base fee + tip: what a transaction pays per gas now
	FeeCapWei             string  `json:"feeCapWei,omitempty"`   // the cap the relayer signs with (3 × base + tip)
	ExecutionCostWei      string  `json:"executionCostWei,omitempty"`
	NewWalletCostWei      string  `json:"newWalletCostWei,omitempty"`
	PendingOperations     int     `json:"pendingOperations"`
	PendingRequiredWei    string  `json:"pendingRequiredWei,omitempty"`
	LowBalanceWei         string  `json:"lowBalanceWei,omitempty"`
	LowBalanceConfigured  bool    `json:"lowBalanceConfigured"`
	ShortfallWei          string  `json:"shortfallWei,omitempty"`
	ExecutionsCovered     *uint64 `json:"executionsCovered,omitempty"`
	Health                string  `json:"health"`
	HealthMessage         string  `json:"healthMessage"`
	CheckedAt             string  `json:"checkedAt"`
	ScannedThroughBlock   *uint64 `json:"scannedThroughBlock,omitempty"`
	HistoryAvailableSince *uint64 `json:"historyAvailableSinceBlock,omitempty"`
}

var healthMessages = map[string]string{
	GasHealthy:      "Gas Service Account has sufficient funds.",
	GasLow:          "Gas balance is running low. Recharge soon.",
	GasInsufficient: "Gas Service Account cannot cover the estimated execution cost. Fund the account before retrying.",
	GasUnknown:      "Gas Service Account balance is unavailable.",
}

// fullSetupSteps is the gas profile of a brand-new wallet key on a chain that
// already has the verifier and factory: every matrix pair plus the account.
func fullSetupSteps(withContracts bool) []setupStep {
	var steps []setupStep
	if withContracts {
		steps = append(steps, setupStep{gas: gasBoundDeployVerifier}, setupStep{gas: gasBoundDeployFactory})
	}
	for p := 0; p < qdaccount.MatrixEntries/qdaccount.MatrixEntriesPerTx; p++ {
		steps = append(steps, setupStep{gas: gasBoundMatrixPair})
	}
	return append(steps, setupStep{gas: gasBoundCreateAccount})
}

// classifyHealth decides the account's health. pendingOps > 0: it must cover
// the pending requirement (insufficient below it, low below it + the low
// threshold). Otherwise it must cover at least one execution.
func classifyHealth(balance, pendingRequired, executionCost, low *big.Int, pendingOps int) (health string, shortfall *big.Int) {
	need := executionCost
	if pendingOps > 0 {
		need = pendingRequired
	}
	if balance.Cmp(need) < 0 {
		return GasInsufficient, new(big.Int).Sub(need, balance)
	}
	if balance.Cmp(new(big.Int).Add(pendingRequired, low)) < 0 {
		return GasLow, big.NewInt(0)
	}
	return GasHealthy, big.NewInt(0)
}

// funding fills the funding view of a chain whose RPC and relayer key work.
func (r *Relayer) funding(ctx context.Context, chainID int64, chain ChainCaller, from common.Address, balance *big.Int, contractsDeployed bool) gasFunding {
	f := gasFunding{Health: GasUnknown, CheckedAt: r.now().UTC().Format(time.RFC3339)}
	if r.Monitor != nil {
		f.ScannedThroughBlock, f.HistoryAvailableSince = r.Monitor.coverage(chainID)
	}
	q, err := r.fees(ctx, chain)
	if err != nil {
		f.HealthMessage = "could not read current gas prices: " + sanitize(err.Error())
		return f
	}
	if bn, err := r.quantity(ctx, chain, "eth_blockNumber", []any{}); err == nil {
		v := bn.Uint64()
		f.BlockNumber = &v
	}
	f.BaseFeeWei, f.TipWei, f.FeeCapWei = q.base.String(), q.tip.String(), q.feeCap.String()
	f.GasPriceWei = new(big.Int).Add(q.base, q.tip).String()
	execCost := requiredWei(nil, q.feeCap)
	f.ExecutionCostWei = execCost.String()
	f.NewWalletCostWei = requiredWei(fullSetupSteps(!contractsDeployed), q.feeCap).String()

	pendingOps, pending := r.pendingRequirement(ctx, chainID, chain, from, q.feeCap)
	f.PendingOperations = pendingOps
	f.PendingRequiredWei = pending.String()

	low := r.LowBalanceWei[chainID]
	f.LowBalanceConfigured = low != nil
	if low == nil {
		// Default: enough to set up one more wallet key and execute once.
		low = requiredWei(fullSetupSteps(false), q.feeCap)
	}
	f.LowBalanceWei = low.String()
	if balance == nil {
		f.HealthMessage = healthMessages[GasUnknown]
		return f
	}
	health, shortfall := classifyHealth(balance, pending, execCost, low, pendingOps)
	f.Health, f.HealthMessage, f.ShortfallWei = health, healthMessages[health], shortfall.String()
	if execCost.Sign() > 0 {
		spare := new(big.Int).Sub(balance, pending)
		if spare.Sign() < 0 {
			spare.SetInt64(0)
		}
		n := new(big.Int).Quo(spare, execCost).Uint64()
		f.ExecutionsCovered = &n
	}
	return f
}

// pendingRequirement sums what the relayer still has to pay for executions
// waiting on this chain: remaining setup (each distinct setup transaction
// counted once, since proposals of one wallet key share it) plus one execute
// per execution, at the fee cap with gas-limit headroom.
func (r *Relayer) pendingRequirement(ctx context.Context, chainID int64, chain ChainCaller, from common.Address, feeCap *big.Int) (int, *big.Int) {
	execs, err := r.store.SharedWallets().ListExecutions(ctx, []store.ExecutionStatus{store.ExecPending, store.ExecSubmitting, store.ExecSubmitted})
	if err != nil {
		return 0, big.NewInt(0)
	}
	seen := map[common.Hash]bool{}
	var gas uint64
	ops := 0
	for _, e := range execs {
		if e.ChainID != chainID {
			continue
		}
		ops++
		gas += gasBoundExecute * 12 / 10
		if e.Status == store.ExecSubmitted {
			continue // setup done; only the broadcast execute is outstanding
		}
		x, err := r.load(ctx, e)
		if err != nil {
			continue
		}
		x.chain, x.from = chain, from
		pre, err := r.preflight(ctx, x)
		if err != nil {
			continue
		}
		for _, s := range pre.steps {
			h := crypto.Keccak256Hash(s.to.Bytes(), s.data)
			if !seen[h] {
				seen[h] = true
				gas += s.gas * 12 / 10
			}
		}
	}
	return ops, new(big.Int).Mul(new(big.Int).SetUint64(gas), feeCap)
}

// GasEstimate is what executing one proposal requires right now: the shared
// account pays the transfer value, the gas service account pays the gas.
type GasEstimate struct {
	ChainID             int64    `json:"chainId"`
	CheckedAt           string   `json:"checkedAt"`
	RPCOK               bool     `json:"rpcOk"`
	RelayerConfigured   bool     `json:"relayerConfigured"`
	RelayerAddress      string   `json:"relayerAddress,omitempty"`
	RelayerBalanceWei   *string  `json:"relayerBalanceWei"`
	AccountAddress      string   `json:"accountAddress"`
	AccountDeployed     *bool    `json:"accountDeployed"`
	AccountBalanceWei   *string  `json:"accountBalanceWei"`
	TransferWei         string   `json:"transferWei"`
	SetupSteps          []string `json:"setupSteps"`
	GasUnits            uint64   `json:"gasUnits"` // upper bound incl. 20 % gas-limit headroom
	BaseFeeWei          string   `json:"baseFeeWei,omitempty"`
	GasPriceWei         string   `json:"gasPriceWei,omitempty"`
	FeeCapWei           string   `json:"feeCapWei,omitempty"`
	RequiredRelayerWei  string   `json:"requiredRelayerWei,omitempty"` // gasUnits × fee cap: must be held before the relayer starts
	EstimatedFeeWei     string   `json:"estimatedFeeWei,omitempty"`    // gasUnits × current gas price: likely upper cost now
	RelayerShortfallWei string   `json:"relayerShortfallWei,omitempty"`
	AccountShortfallWei string   `json:"accountShortfallWei,omitempty"`
	CanProceed          bool     `json:"canProceed"`
	Blocker             string   `json:"blocker,omitempty"`
}

// EstimateProposal runs the relayer's preflight for a proposal without a
// signature and without sending anything.
func (r *Relayer) EstimateProposal(ctx context.Context, prop *store.Proposal, key *store.AccountKey) (*GasEstimate, error) {
	est := &GasEstimate{ChainID: prop.ChainID, CheckedAt: r.now().UTC().Format(time.RFC3339), TransferWei: prop.ValueWei, SetupSteps: []string{}}
	if key == nil {
		est.Blocker = "the sender account has no smart-account address registered yet"
		return est, nil
	}
	est.AccountAddress = key.Address
	call, err := ProposalCall(prop)
	if err != nil {
		return nil, err
	}
	x := &execContext{prop: prop, pk: key.PublicKey, call: call, account: common.HexToAddress(key.Address)}
	copy(x.pkHash[:], key.PublicKeyHash)
	if len(key.PublicKey) >= 32 {
		copy(x.seedA[:], key.PublicKey[:32])
	}
	if qdaccount.AccountAddress(x.pkHash) != x.account {
		est.Blocker = "the registered address is not CREATE2(factory, H(pk)); do not fund it"
		return est, nil
	}
	chain, ok := r.chains(prop.ChainID)
	if !ok {
		est.Blocker = fmt.Sprintf("no RPC configured for chain %d", prop.ChainID)
		return est, nil
	}
	x.chain = chain
	if k, ok := r.keys[prop.ChainID]; ok {
		x.key, x.from = k, crypto.PubkeyToAddress(k.PublicKey)
		est.RelayerConfigured, est.RelayerAddress = true, x.from.Hex()
	}
	got, err := r.quantity(ctx, chain, "eth_chainId", []any{})
	if err != nil {
		est.Blocker = "the network's RPC is unreachable: " + sanitize(err.Error())
		return est, nil
	}
	if got.Int64() != prop.ChainID {
		est.Blocker = fmt.Sprintf("the RPC for chain %d reports chain id %s", prop.ChainID, got)
		return est, nil
	}
	est.RPCOK = true

	pre, err := r.preflight(ctx, x)
	if err != nil {
		est.Blocker = "could not read chain state: " + sanitize(err.Error())
		return est, nil
	}
	for _, s := range pre.steps {
		est.SetupSteps = append(est.SetupSteps, s.label)
	}
	est.GasUnits = requiredGas(pre.steps)
	q := pre.fees
	if q == nil {
		if q, err = r.fees(ctx, chain); err != nil {
			est.Blocker = "could not read gas prices: " + sanitize(err.Error())
			return est, nil
		}
	}
	price := new(big.Int).Add(q.base, q.tip)
	need := requiredWei(pre.steps, q.feeCap)
	est.BaseFeeWei, est.GasPriceWei, est.FeeCapWei = q.base.String(), price.String(), q.feeCap.String()
	est.RequiredRelayerWei = need.String()
	est.EstimatedFeeWei = new(big.Int).Mul(new(big.Int).SetUint64(est.GasUnits), price).String()

	if deployed, err := r.hasCode(ctx, chain, x.account); err == nil {
		est.AccountDeployed = &deployed
	}
	if bal, err := r.balance(ctx, chain, x.account); err == nil {
		s := bal.String()
		est.AccountBalanceWei = &s
		if bal.Cmp(call.Value) < 0 {
			est.AccountShortfallWei = new(big.Int).Sub(call.Value, bal).String()
		}
	}
	if est.RelayerConfigured {
		if bal, err := r.balance(ctx, chain, x.from); err == nil {
			s := bal.String()
			est.RelayerBalanceWei = &s
			if bal.Cmp(need) < 0 {
				est.RelayerShortfallWei = new(big.Int).Sub(need, bal).String()
			}
		}
	}

	switch {
	case !r.now().Before(time.Unix(call.ValidUntil.Int64(), 0)):
		est.Blocker = "the proposal has expired"
	case pre.fatal != "":
		est.Blocker = pre.fatal
	case !est.RelayerConfigured:
		est.Blocker = fmt.Sprintf("no gas service account is configured for chain %d", prop.ChainID)
	case pre.waitStage != "":
		est.Blocker = pre.waitMsg
	case est.AccountShortfallWei != "":
		est.Blocker = "the shared account cannot pay the transfer amount"
	case est.RelayerShortfallWei != "":
		est.Blocker = "the gas service account cannot cover the estimated gas"
	case est.AccountBalanceWei == nil || est.RelayerBalanceWei == nil:
		est.Blocker = "balances are unavailable"
	}
	est.CanProceed = est.Blocker == ""
	return est, nil
}

// ---- history ----------------------------------------------------------------

// GasHistory is the gas service account's recorded history on one chain.
type GasHistory struct {
	ChainID               int64                `json:"chainId"`
	Address               string               `json:"address"`
	ScannedThroughBlock   *uint64              `json:"scannedThroughBlock,omitempty"`
	HistoryAvailableSince *uint64              `json:"historyAvailableSinceBlock,omitempty"`
	Transfers             []*store.GasTransfer `json:"-"`
}

// History returns recorded transfers for a chain's gas service account.
func (r *Relayer) History(ctx context.Context, chainID int64, limit int) (*GasHistory, error) {
	addr, ok := r.RelayerAddress(chainID)
	if !ok {
		return nil, ErrNotFound
	}
	h := &GasHistory{ChainID: chainID, Address: addr.Hex()}
	if r.Monitor != nil {
		h.ScannedThroughBlock, h.HistoryAvailableSince = r.Monitor.coverage(chainID)
	}
	ts, err := r.store.SharedWallets().ListGasTransfers(ctx, chainID, strings.ToLower(addr.Hex()), limit)
	if err != nil {
		return nil, err
	}
	h.Transfers = ts
	return h, nil
}

// ---- receipts -------------------------------------------------------------------

type rawReceipt struct {
	Status            string `json:"status"`
	BlockNumber       string `json:"blockNumber"`
	GasUsed           string `json:"gasUsed"`
	EffectiveGasPrice string `json:"effectiveGasPrice"`
	From              string `json:"from"`
	To                string `json:"to"`
	ContractAddress   string `json:"contractAddress"`
}

func receiptOf(ctx context.Context, chain ChainCaller, hash string) (*rawReceipt, error) {
	raw, err := chain.Call(ctx, "eth_getTransactionReceipt", []any{hash})
	if err != nil {
		return nil, err
	}
	var rc *rawReceipt
	if err := json.Unmarshal(raw, &rc); err != nil {
		return nil, err
	}
	return rc, nil
}

var errNoBlock = errors.New("block not found")

func decBig(s string) *big.Int {
	if v, err := hexutil.DecodeBig(s); err == nil {
		return v
	}
	return big.NewInt(0)
}

func decU64(s string) uint64 {
	v, _ := hexutil.DecodeUint64(s)
	return v
}
