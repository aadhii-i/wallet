package sharedwallet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/qdwallet/wallet-api/internal/platform/config"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/rpc"
	"github.com/qdwallet/wallet-api/internal/store"
)

type feeTestChain struct {
	*fakeChain
	oracleUnavailable bool
	priceUnavailable  bool
	price             uint64
	tipCalls          int
}

func (f *feeTestChain) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	encode := func(value any) (json.RawMessage, error) { return json.Marshal(value) }
	switch method {
	case "eth_getBlockByNumber":
		return encode(map[string]string{"baseFeePerGas": q(100), "gasLimit": q(60_000_000)})
	case "eth_maxPriorityFeePerGas":
		f.tipCalls++
		return encode(q(2))
	case "eth_gasPrice":
		if f.priceUnavailable {
			return nil, errors.New("price unavailable")
		}
		return encode(q(f.price))
	case "eth_call":
		p := params.([]any)
		call := p[0].(map[string]string)
		if common.HexToAddress(call["to"]) == arbitrumGasInfo {
			if f.oracleUnavailable {
				return nil, errors.New("oracle unavailable")
			}
			prices := append(common.LeftPadBytes(big.NewInt(1000).Bytes(), 32), common.LeftPadBytes(big.NewInt(3).Bytes(), 32)...)
			return encode(hexutil.Encode(append(prices, make([]byte, 4*32)...)))
		}
		if common.HexToAddress(call["to"]) == baseGasOracle {
			if f.oracleUnavailable {
				return nil, errors.New("oracle unavailable")
			}
			data := hexutil.MustDecode(call["data"])
			value := new(big.Int).SetBytes(data[4:])
			switch {
			case bytes.Equal(data[:4], crypto.Keccak256([]byte("getL1FeeUpperBound(uint256)"))[:4]):
				value.Mul(value, big.NewInt(3))
			case bytes.Equal(data[:4], crypto.Keccak256([]byte("getOperatorFee(uint256)"))[:4]):
				value.Div(value, big.NewInt(1000))
			default:
				return nil, errors.New("unexpected oracle method")
			}
			return encode(hexutil.Encode(common.LeftPadBytes(value.Bytes(), 32)))
		}
	}
	return f.fakeChain.Call(ctx, method, params)
}

func TestSharedWalletChainFeeModels(t *testing.T) {
	for _, test := range []struct {
		chainID int64
		base    int64
		tip     int64
		cap     int64
	}{
		{11155111, 100, 2, 302},
		{31337, 100, 2, 302},
		{84532, 100, 2, 302},
		{421614, 150, 0, 450},
		{80002, 100, 50, 350},
	} {
		t.Run(fmt.Sprint(test.chainID), func(t *testing.T) {
			chain := &feeTestChain{fakeChain: newFakeChain(t, test.chainID), price: 150}
			relayer := NewRelayer(nil, nil, nil, nil)
			fees, err := relayer.fees(context.Background(), test.chainID, chain, nil)
			if err != nil {
				t.Fatal(err)
			}
			if fees.base.Cmp(big.NewInt(test.base)) != 0 || fees.tip.Cmp(big.NewInt(test.tip)) != 0 || fees.feeCap.Cmp(big.NewInt(test.cap)) != 0 {
				t.Fatalf("unexpected quote: base=%s tip=%s cap=%s", fees.base, fees.tip, fees.feeCap)
			}
			if test.chainID == 421614 && chain.tipCalls != 0 {
				t.Fatal("Arbitrum queried an unused priority fee")
			}
			if (fees.additionalFees(nil).Sign() > 0) != (test.chainID == 84532 || test.chainID == 421614) {
				t.Fatal("additional fees assigned to the wrong network")
			}
			key, err := crypto.GenerateKey()
			if err != nil {
				t.Fatal(err)
			}
			x := &execContext{chain: chain, prop: &store.Proposal{ChainID: test.chainID}, key: key, from: crypto.PubkeyToAddress(key.PublicKey)}
			tx, err := relayer.signTx(context.Background(), x, common.Address{}, []byte{1}, fees)
			if err != nil {
				t.Fatal(err)
			}
			if tx.ChainId().Int64() != test.chainID || tx.GasFeeCap().Cmp(fees.feeCap) != 0 || tx.GasTipCap().Cmp(fees.tip) != 0 {
				t.Fatal("signed transaction differs from the chain-specific quote")
			}
		})
	}
}

func TestSharedWalletNodePriceIsRequired(t *testing.T) {
	for _, chainID := range []int64{421614, 80002} {
		for _, unavailable := range []bool{false, true} {
			chain := &feeTestChain{fakeChain: newFakeChain(t, chainID), priceUnavailable: unavailable}
			if _, err := NewRelayer(nil, nil, nil, nil).fees(context.Background(), chainID, chain, nil); err == nil {
				t.Fatalf("chain %d accepted a missing or zero gas price", chainID)
			}
		}
	}
}

func TestBaseReserveTracksCalldataAndSetupCount(t *testing.T) {
	chain := &feeTestChain{fakeChain: newFakeChain(t, 84532)}
	relayer := NewRelayer(nil, nil, nil, nil)
	call := &qdaccount.Call{Nonce: new(big.Int), Value: new(big.Int), CallGasLimit: big.NewInt(21000), ValidUntil: big.NewInt(1)}
	first, err := relayer.fees(context.Background(), 84532, chain, call)
	if err != nil {
		t.Fatal(err)
	}
	call.Data = make([]byte, 1024)
	larger, err := relayer.fees(context.Background(), 84532, chain, call)
	if err != nil {
		t.Fatal(err)
	}
	if new(big.Int).Sub(larger.extraFee(gasBoundExecute), first.extraFee(gasBoundExecute)).Int64() != 3*1024 {
		t.Fatal("calldata size was not included in the L1 fee bound")
	}
	steps := []setupStep{{gas: gasBoundMatrixPair}, {gas: gasBoundMatrixPair}}
	wantExtra := new(big.Int).Add(first.extraFee(gasBoundExecute), new(big.Int).Mul(first.extraFee(gasBoundMatrixPair), big.NewInt(2)))
	gasCost := new(big.Int).Mul(new(big.Int).SetUint64(requiredGas(steps)), first.feeCap)
	if requiredWei(steps, first).Cmp(new(big.Int).Add(gasCost, wantExtra)) != 0 {
		t.Fatal("funding check omitted an additional fee reserve")
	}
}

func TestRollupCannotPrepareWithoutFeeOracle(t *testing.T) {
	for _, chainID := range []int64{84532, 421614} {
		chain := &feeTestChain{fakeChain: newFakeChain(t, chainID), oracleUnavailable: true}
		x := &execContext{chain: chain, prop: &store.Proposal{ChainID: chainID}}
		if _, err := NewRelayer(nil, nil, nil, nil).signTx(context.Background(), x, common.Address{}, nil, nil); err == nil {
			t.Fatalf("chain %d accepted an incomplete fee quote", chainID)
		}
		if len(chain.sent) != 0 {
			t.Fatal("fee checking submitted a transaction")
		}
	}
}

// Opt-in read-only probes. This test never constructs, signs or broadcasts a transaction.
func TestSharedTestnetFeesLive(t *testing.T) {
	if os.Getenv("QD_SHARED_FEE_READS") != "1" {
		t.Skip("set QD_SHARED_FEE_READS=1 for read-only testnet fee probes")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, chainID := range []int64{11155111, 84532, 421614, 80002} {
		t.Run(fmt.Sprint(chainID), func(t *testing.T) {
			var providers []rpc.Upstream
			for _, provider := range cfg.EVMRPC[chainID] {
				providers = append(providers, rpc.Upstream{Name: provider.Name, URL: provider.URL})
			}
			if len(providers) == 0 {
				t.Fatal("testnet RPC not configured")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
			defer cancel()
			chain := rpc.NewPool(chainID, providers, nil)
			relayer := NewRelayer(nil, nil, nil, nil)
			id, err := relayer.quantity(ctx, chain, "eth_chainId", []any{})
			if err != nil || id.Int64() != chainID {
				t.Fatal("RPC chain identity check failed")
			}
			quote, err := relayer.fees(ctx, chainID, chain, nil)
			if err != nil {
				t.Fatal(err)
			}
			deployer, err := relayer.hasCode(ctx, chain, qdaccount.Deployer)
			if err != nil {
				t.Fatal("deployment-proxy read failed")
			}
			t.Logf("chain=%d blockGasLimit=%d base=%s tip=%s cap=%s executionExtraReserve=%s deployerPresent=%v", chainID, quote.blockGasLimit, quote.base, quote.tip, quote.feeCap, quote.extraFee(gasBoundExecute), deployer)
		})
	}
}
