package sharedwallet

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/store"
)

type liveRPC struct{ url string }

func (l liveRPC) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, l.url, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rpc %s failed", method) // never echo the URL
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rpc %s: http %d", method, res.StatusCode)
	}
	var out struct {
		Result json.RawMessage           `json:"result"`
		Error  *struct{ Message string } `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%s: %s", method, out.Error.Message)
	}
	return out.Result, nil
}

// READ-ONLY, public Sepolia: GET /v1/shared-wallets/{id}/history?chainId=11155111
// for a wallet whose smart account is the real QdAccount 0x420f…52d9, through
// the router, the service and the real chain index. Gated by QD_SEPOLIA_RPC.
func TestLiveSepoliaWalletHistoryEndpoint(t *testing.T) {
	url := os.Getenv("QD_SEPOLIA_RPC")
	if url == "" {
		t.Skip("QD_SEPOLIA_RPC not set")
	}
	const account = "0x420f1c166536b54715f70f733354ab8aab0052d9"
	he := newHistoryEnv(t, 0)
	// The account key registered for this wallet points at the real Sepolia account
	// (its public key is a stand-in: the endpoint only uses the address).
	acct := he.account(he.wid, he.users[0], "Treasury")
	kgID := *must(he.svc.GetWallet(ctx, he.users[0].p, he.wid)).Wallet.KeyGenerationID
	if _, err := he.st.SharedWallets().PutAccountKey(ctx, &store.AccountKey{AccountID: acct.ID, WalletID: he.wid, KeygenID: kgID, DerivationIndex: acct.DerivationIndex,
		PublicKey: fakePublicKey(t), PublicKeyHash: make([]byte, 32), Address: account, CreatedAt: time.Now()}, store.AccountKeyAttestation{MemberID: memberID(he, 0), At: time.Now()}); err != nil {
		t.Fatal(err)
	}
	ix := indexer.New(he.st, func(id int64) (indexer.Caller, bool) { return liveRPC{url}, id == sepolia }, nil)
	ix.ChainIDs = []int64{sepolia}
	// Index from just before the first funding of this account (older blocks are irrelevant here).
	if err := he.st.ChainIndex().PutCursor(ctx, &store.IndexCursor{ChainID: sepolia, Address: account, SinceBlock: 12138300, ScannedThrough: 12138299}); err != nil {
		t.Fatal(err)
	}
	he.h.SetIndex(ix, func(id int64) (*HistoryNetwork, bool) {
		if id != sepolia {
			return nil, false
		}
		return &HistoryNetwork{Name: "Ethereum Sepolia", ExplorerTxURL: func(h string) string { return "https://sepolia.etherscan.io/tx/" + h }}, true
	}, indexer.Sanitize)

	// As in the API: the background index runs continuously; requests also index (8 s budget each).
	bg, stop := context.WithCancel(context.Background())
	defer stop()
	ix.Interval = 5 * time.Second
	go ix.Run(bg)
	var body historyResp
	deadline := time.Now().Add(5 * time.Minute)
	for i := 0; ; i++ {
		code, b, raw := he.get(he.users[1], he.url("11155111"))
		if code != 200 {
			t.Fatalf("GET history: %d %s", code, raw)
		}
		body = b
		t.Logf("request %d: HTTP %d, %d items, index %s %s", i, code, len(b.Items), b.Index.State, b.Index.Error)
		if b.Index.State == IndexOK && len(b.Items) >= 5 {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Second)
	}
	byHash := map[string]map[string]any{}
	for _, it := range body.Items {
		t.Logf("%-8s %-10s %s %s → %s %s wei %s block %v %s", it["direction"], it["kind"], it["txHash"], it["from"], it["to"], it["amount"], it["status"], it["blockNumber"], it["explorerUrl"])
		byHash[it["txHash"].(string)] = it
	}
	want := []struct{ hash, direction, kind, status, amount string }{
		{"0x6e492c9af7ddd68cadd1089cde567c70686afb6de929a0bdc1d03c906d9bbe0d", "received", "native", "confirmed", "30000000000000000"}, // funding
		{"0x6f25f9b440304e99ba7fc2cea03ae16e3b29f321fb83b3f97b8b1bbaf6bf3faa", "sent", "qd_execute", "confirmed", "20000000000000000"}, // 0.02 to the recipient
		{"0x9b80e305b4f0b678e2b6929a9c4fa54d9dbd046f36cc0ce8663ce5a14f78fee4", "received", "native", "failed", "0"},                    // reverted duplicate
		{"0x5ff4c3147d5d3fb5e87bddeb2a9353cb75ce39afed72925ca2602f9df4b8811c", "received", "native", "confirmed", "20000000000000000"}, // 0.02 back
		{"0x06a2ad2169ebaca78a378f2ebe32524f54b4e27cd07e215be85c3c0e9217df19", "sent", "qd_execute", "confirmed", "20000000000000000"}, // 0.02 out
	}
	for _, w := range want {
		it := byHash[w.hash]
		if it == nil || it["direction"] != w.direction || it["kind"] != w.kind || it["status"] != w.status || it["amount"] != w.amount ||
			it["explorerUrl"] != "https://sepolia.etherscan.io/tx/"+w.hash || it["blockTime"] == "" {
			t.Errorf("%s: %+v (want %s %s %s %s)", w.hash, it, w.direction, w.kind, w.status, w.amount)
		}
	}
	if fee := byHash[want[1].hash]["feeWei"]; fee != "183391835" {
		t.Errorf("gas fee of the 0.02 ETH execution: %v", fee)
	}
}

func memberID(he *historyEnv, i int) uuid.UUID {
	return mustMember(he.t, he.env, he.wid, he.users[i]).ID
}
