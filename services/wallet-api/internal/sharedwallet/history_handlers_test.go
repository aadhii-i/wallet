package sharedwallet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/store"
)

// fakeIndex stands in for the chain index: it records what it was asked to
// sync and, like the real one, writes what the chain showed into the store.
type fakeIndex struct {
	st      store.Store
	calls   [][]string
	shared  []bool
	err     error
	onChain []*store.ChainTransfer // "found on chain" during Sync
}

func (f *fakeIndex) Sync(ctx context.Context, chainID int64, addrs []string, shared bool) error {
	f.calls = append(f.calls, append([]string(nil), addrs...))
	f.shared = append(f.shared, shared)
	if f.err != nil {
		return f.err
	}
	for _, t := range f.onChain {
		if t.ChainID == chainID {
			if err := f.st.ChainIndex().RecordTransfer(ctx, t); err != nil {
				return err
			}
		}
	}
	return nil
}

type historyEnv struct {
	*env
	h      *Handlers
	router chi.Router
	ix     *fakeIndex
	wid    uuid.UUID
	users  []*participant
	accts  []string // smart-account addresses of the wallet
}

const sepolia = 11155111

func newHistoryEnv(t *testing.T, accounts int) *historyEnv {
	e := newEnv(t)
	wid, users := e.wallet(3)
	e.fullCeremony(wid, users)
	he := &historyEnv{env: e, wid: wid, users: users}
	for i := 0; i < accounts; i++ {
		acct := e.account(wid, users[0], fmt.Sprintf("Acct %d", i))
		k, err := e.registerAccountKey(users[1], wid, acct, fakePublicKey(t))
		if err != nil {
			t.Fatal(err)
		}
		he.accts = append(he.accts, k.Address)
	}
	he.ix = &fakeIndex{st: e.st}
	he.h = NewHandlers(e.svc)
	he.h.SetIndex(he.ix, func(chainID int64) (*HistoryNetwork, bool) {
		switch chainID {
		case sepolia:
			return &HistoryNetwork{Name: "Ethereum Sepolia", ExplorerTxURL: func(h string) string { return "https://sepolia.etherscan.io/tx/" + h }}, true
		case 31337:
			return &HistoryNetwork{Name: "Localhost (Anvil)", ExplorerTxURL: func(string) string { return "" }}, true
		}
		return nil, false
	}, indexer.Sanitize)
	he.router = chi.NewRouter()
	he.h.Routes(he.router)
	return he
}

type historyResp struct {
	ChainID   int64                      `json:"chainId"`
	Network   string                     `json:"network"`
	Addresses []string                   `json:"addresses"`
	Items     []map[string]any           `json:"items"`
	Coverage  map[string]json.RawMessage `json:"coverage"`
	Index     struct {
		State string `json:"state"`
		Error string `json:"error"`
	} `json:"index"`
	Code string `json:"code"`
}

func (he *historyEnv) get(u *participant, path string) (int, historyResp, string) {
	he.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if u != nil {
		req = req.WithContext(auth.WithPrincipal(req.Context(), u.p))
	}
	rec := httptest.NewRecorder()
	he.router.ServeHTTP(rec, req)
	var body historyResp
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body, rec.Body.String()
}

func (he *historyEnv) url(chain string) string {
	return fmt.Sprintf("/v1/shared-wallets/%s/history?chainId=%s", he.wid, chain)
}

func transfer(hash string, logIndex int64, kind, from, to, amount string, ok bool) *store.ChainTransfer {
	return &store.ChainTransfer{ChainID: sepolia, TxHash: hash, LogIndex: logIndex, Kind: kind, From: from, To: to, Amount: amount, Success: ok,
		TxFrom: "0x8c446ea9ce9280fd459ae7152faacd10f49ebdc4", BlockNumber: 12138441, BlockTime: time.Date(2026, 11, 15, 6, 0, 0, 0, time.UTC),
		GasUsed: 10787755, GasPriceWei: "17", FeeWei: "183391835"}
}

func TestWalletHistoryRouteIsRegisteredAndValidates(t *testing.T) {
	he := newHistoryEnv(t, 1)
	// The route exists (401 without a principal comes from the auth middleware in main; here: member check).
	code, _, raw := he.get(he.users[0], he.url("11155111"))
	if code != http.StatusOK {
		t.Fatalf("GET history: %d %s", code, raw)
	}
	for _, c := range []struct {
		path, want string
		status     int
	}{
		{fmt.Sprintf("/v1/shared-wallets/%s/history", he.wid), "INVALID_QUERY", 400},
		{he.url("sepolia"), "INVALID_QUERY", 400},
		{he.url("-1"), "INVALID_QUERY", 400},
		{he.url("1"), "UNSUPPORTED_NETWORK", 400}, // mainnet: not served by this server
		{"/v1/shared-wallets/not-a-uuid/history?chainId=11155111", "NOT_FOUND", 404},
		{fmt.Sprintf("/v1/shared-wallets/%s/history?chainId=11155111", uuid.New()), "NOT_FOUND", 404},
	} {
		code, body, raw := he.get(he.users[0], c.path)
		if code != c.status || body.Code != c.want {
			t.Errorf("%s: %d %s (want %d %s)", c.path, code, raw, c.status, c.want)
		}
	}
	// A non-member gets 404 (never 403), and learns nothing.
	outsider := &participant{p: &auth.Principal{UserID: uuid.New(), DeviceID: uuid.New()}}
	if code, body, _ := he.get(outsider, he.url("11155111")); code != 404 || body.Code != "NOT_FOUND" || len(he.ix.calls) != 1 {
		t.Fatalf("outsider: %d %s (sync calls %d)", code, body.Code, len(he.ix.calls))
	}
	// Wrong method: no handler.
	req := httptest.NewRequest(http.MethodPost, he.url("11155111"), nil)
	rec := httptest.NewRecorder()
	he.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", rec.Code)
	}
}

func TestWalletHistoryEmptyWalletReturnsArrays(t *testing.T) {
	he := newHistoryEnv(t, 0) // no smart account yet
	code, body, raw := he.get(he.users[2], he.url("11155111"))
	if code != 200 || body.Addresses == nil || body.Items == nil || len(body.Items) != 0 || body.Index.State != IndexOK {
		t.Fatalf("empty wallet: %d %s", code, raw)
	}
	if !strings.Contains(raw, `"addresses":[]`) || !strings.Contains(raw, `"items":[]`) {
		t.Fatalf("lists must be [] (never null): %s", raw)
	}
	if len(he.ix.calls) != 0 {
		t.Fatal("nothing to index without an address")
	}
	// An account but no transactions yet.
	he2 := newHistoryEnv(t, 1)
	if code, body, raw := he2.get(he2.users[0], he2.url("11155111")); code != 200 || len(body.Addresses) != 1 || len(body.Items) != 0 || !strings.Contains(raw, `"items":[]`) {
		t.Fatalf("no transactions: %d %s", code, raw)
	}
}

func TestWalletHistoryIncomingOutgoingMultipleAccountsScopedAndDeduplicated(t *testing.T) {
	he := newHistoryEnv(t, 2)
	a1, a2 := he.accts[0], he.accts[1]
	stranger := "0x00000000000000000000000000000000000000b0"
	other := newHistoryEnv(t, 1) // another wallet, sharing nothing
	h := func(n int) string { return fmt.Sprintf("0x%064x", n) }
	he.ix.onChain = []*store.ChainTransfer{
		transfer(h(1), 67, store.TransferQdExecute, a1, stranger, "20000000000000000", true), // a1 sent
		transfer(h(2), -1, store.TransferNative, stranger, a2, "30000000000000000", true),    // a2 received
		transfer(h(3), 4, store.TransferERC20, stranger, a1, "1234", true),                   // token received
		transfer(h(4), -1, store.TransferNative, stranger, a1, "0", false),                   // failed call to a1
		transfer(h(5), 2, store.TransferQdExecute, a1, a2, "5", true),                        // between the wallet's accounts
		transfer(h(6), -1, store.TransferNative, stranger, other.accts[0], "7", true),        // another wallet's
	}
	he.ix.onChain[2].Token = "0x00000000000000000000000000000000000070c0"
	for i := 0; i < 3; i++ { // repeated indexing never duplicates
		code, body, raw := he.get(he.users[1], he.url("11155111"))
		if code != 200 || len(body.Items) != 5 {
			t.Fatalf("pass %d: %d %d items %s", i, code, len(body.Items), raw)
		}
	}
	_, body, _ := he.get(he.users[1], he.url("11155111"))
	if len(he.ix.calls[0]) != 2 || !he.ix.shared[0] {
		t.Fatalf("both smart accounts must be indexed as shared accounts: %v %v", he.ix.calls[0], he.ix.shared[0])
	}
	got := map[string]map[string]any{}
	for _, it := range body.Items {
		got[it["txHash"].(string)] = it
	}
	check := func(hash, direction, status string) map[string]any {
		t.Helper()
		it := got[hash]
		if it == nil || it["direction"] != direction || it["status"] != status {
			t.Fatalf("%s: %+v (want %s %s)", hash, it, direction, status)
		}
		return it
	}
	sent := check(h(1), "sent", "confirmed")
	if sent["explorerUrl"] != "https://sepolia.etherscan.io/tx/"+h(1) || sent["amount"] != "20000000000000000" || sent["from"] != a1 || sent["to"] != stranger ||
		sent["blockTime"] != "2026-11-15T06:00:00Z" || sent["feeWei"] != "183391835" || sent["blockNumber"].(float64) != 12138441 {
		t.Fatalf("sent entry: %+v", sent)
	}
	check(h(2), "received", "confirmed")
	if tok := check(h(3), "received", "confirmed"); tok["token"] != "0x00000000000000000000000000000000000070c0" || tok["kind"] != "erc20" {
		t.Fatalf("token entry: %+v", tok)
	}
	check(h(4), "received", "failed")
	check(h(5), "self", "confirmed")
	if _, leaked := got[h(6)]; leaked {
		t.Fatal("another wallet's transaction is in this wallet's history")
	}
	// The other wallet sees only its own.
	other.ix.onChain = he.ix.onChain
	if _, ob, _ := other.get(other.users[0], other.url("11155111")); len(ob.Items) != 1 || ob.Items[0]["txHash"] != h(6) {
		t.Fatalf("other wallet: %+v", ob.Items)
	}
	// Per chain: nothing recorded on Anvil for this wallet.
	if _, ab, _ := he.get(he.users[1], he.url("31337")); len(ab.Items) != 0 {
		t.Fatalf("anvil history: %+v", ab.Items)
	}
}

func TestWalletHistoryRPCFailuresAreReportedNotHidden(t *testing.T) {
	he := newHistoryEnv(t, 1)
	he.ix.onChain = []*store.ChainTransfer{transfer(fmt.Sprintf("0x%064x", 1), -1, store.TransferNative, "0x00000000000000000000000000000000000000b0", he.accts[0], "1", true)}
	he.get(he.users[0], he.url("11155111")) // indexed once while the RPC worked

	he.ix.err = errors.New(`eth_getLogs: Post "https://eth-sepolia.g.alchemy.com/v2/SECRETKEY": dial tcp: connection refused`)
	code, body, raw := he.get(he.users[0], he.url("11155111"))
	if code != 200 || body.Index.State != IndexRPCError || len(body.Items) != 1 {
		t.Fatalf("rpc error: %d %s", code, raw)
	}
	if strings.Contains(raw, "SECRETKEY") || strings.Contains(body.Index.Error, "https://") || !strings.Contains(body.Index.Error, "connection refused") {
		t.Fatalf("error must be reported without the RPC URL: %q", body.Index.Error)
	}
	he.ix.err = fmt.Errorf("%w: chain %d", indexer.ErrNoRPC, sepolia)
	if _, body, raw := he.get(he.users[0], he.url("11155111")); body.Index.State != IndexRPCUnavailable || len(body.Items) != 1 {
		t.Fatalf("no rpc: %s", raw)
	}
}

// slowIndex runs out of the request's time (e.g. a first pass on a rate-limited provider).
type slowIndex struct{ fakeIndex }

func (s *slowIndex) Sync(ctx context.Context, chainID int64, addrs []string, shared bool) error {
	<-ctx.Done()
	return fmt.Errorf("rpc eth_getLogs failed: %w", ctx.Err())
}

func TestWalletHistoryReportsIndexingWhenTheRequestRunsOutOfTime(t *testing.T) {
	he := newHistoryEnv(t, 1)
	he.h.index = &slowIndex{}
	start := time.Now()
	code, body, raw := he.get(he.users[0], he.url("11155111"))
	if code != 200 || body.Index.State != IndexIndexing || body.Index.Error != "" || len(body.Items) != 0 {
		t.Fatalf("indexing: %d %s", code, raw)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("the request waited %s", d)
	}
}
