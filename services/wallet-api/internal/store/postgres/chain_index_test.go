package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/qdwallet/wallet-api/internal/store"
)

func TestPostgresChainIndexAndGasTransfers(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	chain := time.Now().UnixNano() % 1_000_000_000 // isolate from other runs on the same database
	me := fmt.Sprintf("0x%040x", chain)
	account := fmt.Sprintf("0x%040x", chain+1)
	at := time.Date(2026, 11, 15, 7, 0, 0, 0, time.UTC)
	rec := &store.ChainTransfer{ChainID: chain, TxHash: "0xABC", LogIndex: 1, Kind: store.TransferQdExecute, From: account, To: me,
		Amount: "20000000000000000", TxFrom: "0xee", TxTo: account, Success: true, BlockNumber: 9, BlockTime: at, GasUsed: 10, GasPriceWei: "17", FeeWei: "170"}
	for i := 0; i < 3; i++ { // idempotent
		if err := st.ChainIndex().RecordTransfer(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	// Same transaction, another log: a separate record.
	other := *rec
	other.LogIndex, other.Kind, other.Token, other.Amount = 2, store.TransferERC20, "0x70c", "123456789012345678901234567890"
	if err := st.ChainIndex().RecordTransfer(ctx, &other); err != nil {
		t.Fatal(err)
	}
	got, err := st.ChainIndex().ListTransfers(ctx, chain, []string{me}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].TxHash != "0xabc" || got[0].Amount != "20000000000000000" || !got[0].BlockTime.Equal(at) || got[1].Amount != "123456789012345678901234567890" {
		t.Fatalf("list: %+v", got)
	}
	if bySender, _ := st.ChainIndex().ListTransfers(ctx, chain, []string{account}, 0); len(bySender) != 2 {
		t.Fatalf("by sender: %d", len(bySender))
	}
	if _, err := st.ChainIndex().GetCursor(ctx, chain, me); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing cursor: %v", err)
	}
	for _, through := range []uint64{100, 250} {
		if err := st.ChainIndex().PutCursor(ctx, &store.IndexCursor{ChainID: chain, Address: me, SinceBlock: 1, ScannedThrough: through}); err != nil {
			t.Fatal(err)
		}
	}
	if c, err := st.ChainIndex().GetCursor(ctx, chain, me); err != nil || c.ScannedThrough != 250 || c.SinceBlock != 1 {
		t.Fatalf("cursor: %+v %v", c, err)
	}

	// Gas service history: idempotent, proposal link filled in later.
	gt := &store.GasTransfer{ChainID: chain, TxHash: "0xdef", Address: "0xee", Direction: store.GasOut, Kind: store.GasKindOther, ValueWei: "0",
		GasUsed: 21000, GasPriceWei: "17", FeeWei: "357000", Success: true, BlockNumber: 9, BlockTime: at}
	if err := st.SharedWallets().RecordGasTransfer(ctx, gt); err != nil {
		t.Fatal(err)
	}
	linked := *gt // the same transaction, now known to be an execution
	linked.Kind = store.GasKindExecute
	if err := st.SharedWallets().RecordGasTransfer(ctx, &linked); err != nil {
		t.Fatal(err)
	}
	gs, err := st.SharedWallets().ListGasTransfers(ctx, chain, "0xEE", 0)
	if err != nil || len(gs) != 1 || gs[0].Kind != store.GasKindExecute || gs[0].FeeWei != "357000" {
		t.Fatalf("gas transfers: %+v %v", gs, err)
	}
}
