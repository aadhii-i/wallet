package store

import (
	"context"
	"time"
)

// Chain index: value transfers read from blockchain receipts and logs for the
// addresses the API knows about (personal wallet addresses and shared
// QdAccount addresses). It is the persistent source for personal Activity
// and shared Wallet History; the chain stays the source of truth for
// balances, and every record is derived from a mined receipt.

// Transfer kinds.
const (
	// TransferNative: the transaction's own value transfer (or a call with
	// no value); LogIndex = LogIndexTx.
	TransferNative = "native"
	// TransferQdExecute: a QdAccount.Executed event (the shared account's
	// call to `To` with `Amount`); LogIndex = the event's log index.
	TransferQdExecute = "qd_execute"
	// TransferERC20: an ERC-20 Transfer event; Token is the contract.
	TransferERC20 = "erc20"
	// TransferInternal: a balance increase in a block that no transaction or
	// decoded event explains (ETH sent by an unknown contract); TxHash is
	// "internal:<block>:<address>", LogIndex = LogIndexInternal.
	TransferInternal = "internal"
)

const (
	LogIndexTx       int64 = -1
	LogIndexInternal int64 = -2
)

// ChainTransfer is unique per (ChainID, TxHash, LogIndex).
type ChainTransfer struct {
	ChainID     int64
	TxHash      string // lower-case
	LogIndex    int64
	Kind        string
	From        string // lower-case: who the value left
	To          string // lower-case: who it reached
	Token       string // "" for the native coin, else the token contract (lower-case)
	Amount      string // base units, decimal
	TxFrom      string // the transaction's sender (who paid gas)
	TxTo        string // the transaction's recipient
	Success     bool   // receipt status 1 and, for qd_execute, Executed.success
	BlockNumber uint64
	BlockTime   time.Time
	GasUsed     uint64
	GasPriceWei string // effective gas price
	FeeWei      string // gasUsed × effective gas price, paid by TxFrom
	CreatedAt   time.Time
}

// IndexCursor is how far the index has scanned one address on one chain.
type IndexCursor struct {
	ChainID        int64
	Address        string
	SinceBlock     uint64 // first block covered
	ScannedThrough uint64 // last block fully scanned
	UpdatedAt      time.Time
}

// WatchedAddress is an address the index follows.
type WatchedAddress struct {
	Address string // lower-case
	Kind    string // "personal" | "shared"
}

type ChainIndex interface {
	// RecordTransfer inserts t; an existing (chain, hash, log index) is left
	// unchanged (re-indexing never duplicates or rewrites a record).
	RecordTransfer(ctx context.Context, t *ChainTransfer) error
	// ListTransfers returns transfers on chainID from or to any of the
	// addresses (or sent by them), newest first.
	ListTransfers(ctx context.Context, chainID int64, addresses []string, limit int) ([]*ChainTransfer, error)
	GetCursor(ctx context.Context, chainID int64, address string) (*IndexCursor, error) // ErrNotFound if none
	PutCursor(ctx context.Context, c *IndexCursor) error
	// WatchedAddresses lists every personal (EVM) and shared-account address.
	WatchedAddresses(ctx context.Context) ([]WatchedAddress, error)
}
