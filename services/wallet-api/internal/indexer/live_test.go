package indexer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

// httpCaller is a bare JSON-RPC client for the read-only live check.
type httpCaller struct{ url string }

func (h httpCaller) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rpc %s failed", method) // never echo the URL (it carries the provider key)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rpc %s: http %d", method, res.StatusCode)
	}
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%s: %s", method, out.Error.Message)
	}
	return out.Result, nil
}

// READ-ONLY: indexes the public Sepolia shared-wallet transfer of 0.02 ETH
// (block 12138441) for the recipient and the shared account, from chain data
// only. Gated by QD_SEPOLIA_RPC.
func TestLiveSepoliaSharedToPersonal(t *testing.T) {
	url := os.Getenv("QD_SEPOLIA_RPC")
	if url == "" {
		t.Skip("QD_SEPOLIA_RPC not set")
	}
	const (
		tx        = "0x6f25f9b440304e99ba7fc2cea03ae16e3b29f321fb83b3f97b8b1bbaf6bf3faa"
		account   = "0x420f1c166536b54715f70f733354ab8aab0052d9"
		recipient = "0x8e4ee0859fd55299e63eacf1f234ac1be7eb6cbe"
		relayer   = "0x8c446ea9ce9280fd459ae7152faacd10f49ebdc4"
	)
	st := memory.New()
	ix := New(st, func(id int64) (Caller, bool) { return httpCaller{url}, id == 11155111 }, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	for _, a := range []string{recipient, account} {
		// Start just before the transaction (history before it is not needed here).
		if err := st.ChainIndex().PutCursor(ctx, &store.IndexCursor{ChainID: 11155111, Address: a, SinceBlock: 12138300, ScannedThrough: 12138299}); err != nil {
			t.Fatal(err)
		}
	}
	if err := ix.Sync(ctx, 11155111, []string{recipient}, false); err != nil {
		t.Fatal(err)
	}
	if err := ix.Sync(ctx, 11155111, []string{account}, true); err != nil {
		t.Fatal(err)
	}
	for _, who := range []string{recipient, account} {
		recs, _ := st.ChainIndex().ListTransfers(ctx, 11155111, []string{who}, 0)
		var got *store.ChainTransfer
		for _, r := range recs {
			t.Logf("%s: %s %s log %d %s → %s %s wei success=%v block %d fee %s", who, r.Kind, r.TxHash, r.LogIndex, r.From, r.To, r.Amount, r.Success, r.BlockNumber, r.FeeWei)
			if r.TxHash == tx {
				got = r
			}
		}
		if got == nil || got.Kind != store.TransferQdExecute || got.From != account || got.To != recipient || got.Amount != "20000000000000000" ||
			!got.Success || got.TxFrom != relayer || got.BlockNumber != 12138441 || got.GasUsed != 10787755 {
			t.Fatalf("%s: the 0.02 ETH transfer is not indexed as expected: %+v", who, got)
		}
	}
}
