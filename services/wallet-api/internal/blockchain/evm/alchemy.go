package evm

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// AlchemyProvider implements HistoryProvider using alchemy_getAssetTransfers
// (spec §11.5), called through the pool's first provider named "alchemy" so
// the provider's URL/API key never leaves internal/rpc.
type AlchemyProvider struct {
	caller RPCCaller
}

func NewAlchemyProvider(caller RPCCaller) *AlchemyProvider {
	return &AlchemyProvider{caller: caller}
}

type alchemyTransfersResult struct {
	Transfers []alchemyTransfer `json:"transfers"`
}

type alchemyTransfer struct {
	Hash        string `json:"hash"`
	From        string `json:"from"`
	To          string `json:"to"`
	Value       any    `json:"value"`
	Asset       string `json:"asset"`
	RawContract struct {
		Address string `json:"address"`
		Value   string `json:"value"`
	} `json:"rawContract"`
	BlockNum string `json:"blockNum"`
	Category string `json:"category"`
}

func (a *AlchemyProvider) FetchActivity(ctx context.Context, networkID string, addresses []string) ([]ActivityItem, error) {
	var items []ActivityItem
	for _, addr := range addresses {
		out, err := a.fetchDirection(ctx, networkID, addr, "fromAddress", "out")
		if err != nil {
			return nil, err
		}
		items = append(items, out...)
		in, err := a.fetchDirection(ctx, networkID, addr, "toAddress", "in")
		if err != nil {
			return nil, err
		}
		items = append(items, in...)
	}
	return items, nil
}

func (a *AlchemyProvider) fetchDirection(ctx context.Context, networkID, address, addressParam, direction string) ([]ActivityItem, error) {
	params := map[string]any{
		addressParam:   address,
		"category":     []string{"external", "erc20"},
		"withMetadata": false,
	}
	raw, err := a.caller.Call(ctx, "alchemy_getAssetTransfers", []any{params})
	if err != nil {
		return nil, err
	}
	var result alchemyTransfersResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	items := make([]ActivityItem, 0, len(result.Transfers))
	for _, t := range result.Transfers {
		assetID := networkID + ":native"
		if t.RawContract.Address != "" {
			assetID = networkID + ":" + strings.ToLower(t.RawContract.Address)
		}
		blockNum, _ := strconv.ParseInt(strings.TrimPrefix(t.BlockNum, "0x"), 16, 64)
		amount := t.RawContract.Value
		if amount == "" {
			amount = "0x0"
		}
		items = append(items, ActivityItem{
			Hash: t.Hash, NetworkID: networkID, Direction: direction,
			From: t.From, To: t.To, AssetID: assetID, Amount: hexToDecimalString(amount),
			Status: "confirmed", BlockNumber: blockNum,
		})
	}
	return items, nil
}
