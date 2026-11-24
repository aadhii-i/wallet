package sharedwallet

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/qdwallet/wallet-api/internal/qdaccount"
	"github.com/qdwallet/wallet-api/internal/qdraccoon"
)

var baseGasOracle = common.HexToAddress("0x420000000000000000000000000000000000000F")
var arbitrumGasInfo = common.HexToAddress("0x000000000000000000000000000000000000006c")

func (q *feeQuote) extraFee(gas uint64) *big.Int {
	if fee := q.extraFees[gas]; fee != nil {
		return fee
	}
	return new(big.Int)
}

func (q *feeQuote) additionalFees(steps []setupStep) *big.Int {
	fee := new(big.Int).Set(q.extraFee(gasBoundExecute))
	for _, step := range steps {
		fee.Add(fee, q.extraFee(step.gas))
	}
	return fee
}

// Size-based profiles account for the Raccoon signature without assuming it
// compresses well. Rollup-specific callers convert them into funding reserves.
// General funding diagnostics use the largest accepted inner calldata.
func feeProfiles(call *qdaccount.Call) ([]setupStep, error) {
	if call == nil {
		call = &qdaccount.Call{
			Nonce: new(big.Int), Value: new(big.Int), CallGasLimit: new(big.Int),
			ValidUntil: new(big.Int), Data: make([]byte, maxDataBytes),
		}
	}
	execution, err := qdaccount.ExecuteCalldata(call, make([]byte, qdraccoon.PublicKeyBytes), make([]byte, qdraccoon.SignatureBytes))
	if err != nil {
		return nil, err
	}
	matrix, err := qdaccount.ExpandMatrixCalldata([32]byte{}, 0, qdaccount.MatrixEntriesPerTx)
	if err != nil {
		return nil, err
	}
	account, err := qdaccount.CreateAccountCalldata([32]byte{})
	if err != nil {
		return nil, err
	}
	return []setupStep{
		{gas: gasBoundDeployVerifier, data: qdaccount.DeployerCalldata(qdaccount.VerifierInitCode())},
		{gas: gasBoundDeployFactory, data: qdaccount.DeployerCalldata(qdaccount.FactoryInitCode())},
		{gas: gasBoundMatrixPair, data: matrix},
		{gas: gasBoundCreateAccount, data: account},
		{gas: gasBoundExecute, data: execution},
	}, nil
}

func (r *Relayer) baseFeeReserves(ctx context.Context, chain ChainCaller, call *qdaccount.Call) (map[uint64]*big.Int, error) {
	profiles, err := feeProfiles(call)
	if err != nil {
		return nil, err
	}
	fees := make(map[uint64]*big.Int, len(profiles))
	for _, profile := range profiles {
		// 256 bytes bound the type-2 RLP fields, including maximum-size fees,
		// nonce, chain ID, gas and value. The oracle adds signature overhead.
		unsignedSize := big.NewInt(int64(len(profile.data) + 256))
		l1, err := baseOracleUint(ctx, chain, "getL1FeeUpperBound(uint256)", unsignedSize)
		if err != nil {
			return nil, fmt.Errorf("Base L1 data fee unavailable: %w", err)
		}
		operatorGas := profile.gas * 12 / 10
		if operatorGas > r.MaxGas {
			operatorGas = r.MaxGas
		}
		operator, err := baseOracleUint(ctx, chain, "getOperatorFee(uint256)", new(big.Int).SetUint64(operatorGas))
		if err != nil {
			return nil, fmt.Errorf("Base operator fee unavailable: %w", err)
		}
		fees[profile.gas] = new(big.Int).Add(l1, operator)
	}
	return fees, nil
}

func baseOracleUint(ctx context.Context, chain ChainCaller, signature string, argument *big.Int) (*big.Int, error) {
	data := append(crypto.Keccak256([]byte(signature))[:4], common.LeftPadBytes(argument.Bytes(), 32)...)
	value, err := feeOracleData(ctx, chain, baseGasOracle, data, 32)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(value), nil
}

func feeOracleData(ctx context.Context, chain ChainCaller, address common.Address, data []byte, size int) ([]byte, error) {
	raw, err := chain.Call(ctx, "eth_call", []any{map[string]string{"to": address.Hex(), "data": hexutil.Encode(data)}, "latest"})
	if err != nil {
		return nil, err
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, fmt.Errorf("invalid oracle response")
	}
	value, err := hexutil.Decode(encoded)
	if err != nil || len(value) != size {
		return nil, fmt.Errorf("oracle returned an invalid response size")
	}
	return value, nil
}

// ArbGasInfo prices the fixed transaction envelope and uncompressed calldata.
// The reserve covers posting gas at the signed fee cap with the same headroom
// used by signTx. eth_estimateGas itself includes posting gas, so the reserve
// is added only to funding diagnostics, never again to the signed gas limit.
func (r *Relayer) arbitrumFeeReserves(ctx context.Context, chain ChainCaller, call *qdaccount.Call, quote *feeQuote) (map[uint64]*big.Int, error) {
	prices, err := feeOracleData(ctx, chain, arbitrumGasInfo, crypto.Keccak256([]byte("getPricesInWei()"))[:4], 6*32)
	if err != nil {
		return nil, fmt.Errorf("Arbitrum posting fee unavailable: %w", err)
	}
	fixed := new(big.Int).SetBytes(prices[:32])
	perByte := new(big.Int).SetBytes(prices[32:64])
	profiles, err := feeProfiles(call)
	if err != nil {
		return nil, err
	}
	fees := make(map[uint64]*big.Int, len(profiles))
	for _, profile := range profiles {
		cost := new(big.Int).Mul(big.NewInt(int64(len(profile.data)+256)), perByte)
		cost.Add(cost, fixed)
		postingGas := new(big.Int).Add(cost, new(big.Int).Sub(quote.base, big.NewInt(1)))
		postingGas.Div(postingGas, quote.base)
		postingGas.Mul(postingGas, big.NewInt(12))
		postingGas.Add(postingGas, big.NewInt(9)).Div(postingGas, big.NewInt(10))
		fees[profile.gas] = postingGas.Mul(postingGas, quote.feeCap)
	}
	return fees, nil
}
