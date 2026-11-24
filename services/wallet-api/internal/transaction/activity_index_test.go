package transaction

import (
	"testing"
	"time"

	"github.com/qdwallet/wallet-api/internal/store"
)

func TestIndexedToMergedPerspective(t *testing.T) {
	me, account, relayer, other := "0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000ee", "0x00000000000000000000000000000000000000b0"
	at := time.Date(2026, 11, 15, 7, 0, 0, 0, time.UTC)
	recs := []*store.ChainTransfer{
		// Shared account → me (relayer paid gas): Received, from the shared account, no fee for me.
		{TxHash: "0x01", LogIndex: 1, Kind: store.TransferQdExecute, From: account, To: me, Amount: "20000000000000000", TxFrom: relayer, Success: true, BlockNumber: 9, BlockTime: at, FeeWei: "183391835"},
		// My failed send: out, failed, with my fee.
		{TxHash: "0x02", LogIndex: store.LogIndexTx, Kind: store.TransferNative, From: me, To: other, Amount: "5", TxFrom: me, Success: false, BlockNumber: 10, BlockTime: at, FeeWei: "357000"},
		// An ERC-20 I received.
		{TxHash: "0x03", LogIndex: 4, Kind: store.TransferERC20, From: other, To: me, Token: "0x00000000000000000000000000000000000070c0", Amount: "1234", TxFrom: other, Success: true, BlockNumber: 11, BlockTime: at},
		// Not mine at all.
		{TxHash: "0x04", LogIndex: store.LogIndexTx, Kind: store.TransferNative, From: other, To: relayer, Amount: "1", Success: true},
	}
	got := indexedToMerged(recs, "sepolia", []string{me})
	if len(got) != 3 {
		t.Fatalf("items: %+v", got)
	}
	in := got[0]
	if in.Direction != "in" || in.From != account || in.Amount != "20000000000000000" || in.AssetID != "sepolia:native" || in.Status != "confirmed" || in.Fee != "" || !in.Timestamp.Equal(at) {
		t.Fatalf("received from shared account: %+v", in)
	}
	if out := got[1]; out.Direction != "out" || out.Status != "failed" || out.Fee != "357000" {
		t.Fatalf("failed send: %+v", out)
	}
	if tok := got[2]; tok.AssetID != "sepolia:0x00000000000000000000000000000000000070c0" || tok.Direction != "in" {
		t.Fatalf("erc20: %+v", tok)
	}
	// The same transaction from the device's own tracking does not duplicate the indexed item.
	merged := dedupeByHash(append(got, mergedItem{Hash: "0x02", NetworkID: "sepolia", AssetID: "sepolia:native", Status: "pending"}))
	if len(merged) != 3 || merged[1].Status != "failed" {
		t.Fatalf("dedupe: %+v", merged)
	}
}
