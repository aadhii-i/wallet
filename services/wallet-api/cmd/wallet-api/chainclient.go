package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/qdwallet/wallet-api/internal/transaction"
)

// GetTransactionReceipt implements transaction.ChainClient by calling
// eth_getTransactionReceipt on the pool for networkID's chain.
func (c *chainClient) GetTransactionReceipt(ctx context.Context, networkID, hash string) (*transaction.Receipt, error) {
	pool, ok := c.poolForNetwork(networkID)
	if !ok {
		return nil, errors.New("chainclient: unknown network " + networkID)
	}
	raw, err := pool.Call(ctx, "eth_getTransactionReceipt", []string{hash})
	if err != nil {
		return nil, err
	}
	if string(raw) == "null" || len(raw) == 0 {
		return nil, nil
	}
	var receipt struct {
		Status      string `json:"status"`
		BlockNumber string `json:"blockNumber"`
	}
	if err := json.Unmarshal(raw, &receipt); err != nil {
		return nil, err
	}
	status, _ := strconv.ParseUint(strings.TrimPrefix(receipt.Status, "0x"), 16, 64)
	blockNumber, _ := strconv.ParseUint(strings.TrimPrefix(receipt.BlockNumber, "0x"), 16, 64)
	return &transaction.Receipt{Status: status, BlockNumber: blockNumber}, nil
}

// GetTransactionCount implements transaction.ChainClient by calling
// eth_getTransactionCount(address, "latest") on the pool for networkID's chain.
func (c *chainClient) GetTransactionCount(ctx context.Context, networkID, address string) (uint64, error) {
	pool, ok := c.poolForNetwork(networkID)
	if !ok {
		return 0, errors.New("chainclient: unknown network " + networkID)
	}
	raw, err := pool.Call(ctx, "eth_getTransactionCount", []string{address, "latest"})
	if err != nil {
		return 0, err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimPrefix(hexStr, "0x"), 16, 64)
}

var _ transaction.ChainClient = (*chainClient)(nil)
