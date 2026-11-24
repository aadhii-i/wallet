package btc

import (
	"context"
	"net/http"
	"testing"
)

func TestUpstreamIdentityMustMatchConfiguredChain(t *testing.T) {
	f := newFakeEsplora(t)
	router := newBTCRouter(NewHandlers(f.service(NetworkTestnet4, 1, 500)))
	for _, tc := range []struct {
		genesis string
		status  int
	}{
		{"00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043", 200},
		{"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", 503},
		{"invalid", 503},
	} {
		f.onText("/block-height/0", tc.genesis)
		if got := do(t, router, http.MethodGet, "/v1/btc/testnet4/identity", ""); got.Code != tc.status {
			t.Fatalf("identity status %d, want %d", got.Code, tc.status)
		}
	}
}

func TestUTXOsRejectInvalidUpstreamData(t *testing.T) {
	for _, kind := range []string{"duplicate", "negative", "future-block", "bad-id", "tip-unavailable"} {
		t.Run(kind, func(t *testing.T) {
			f := newFakeEsplora(t)
			if kind != "tip-unavailable" {
				f.onText("/blocks/tip/height", "100")
			}
			coin := EsploraUTXO{TxID: testTxID, Vout: 0, Value: 1000}
			coin.Status.Confirmed = true
			coin.Status.BlockHeight = 99
			switch kind {
			case "negative":
				coin.Value = -1
			case "future-block":
				coin.Status.BlockHeight = 101
			case "bad-id":
				coin.TxID = "invalid"
			}
			coins := []EsploraUTXO{coin}
			if kind == "duplicate" {
				coins = append(coins, coin)
			}
			f.onJSON("/address/"+testMainnetAddr+"/utxo", coins)
			_, err := f.service(NetworkMainnet, 1, 500).UTXOs(context.Background(), testMainnetAddr)
			if err == nil {
				t.Fatal("invalid upstream UTXOs were accepted")
			}
		})
	}
}

func TestRawTransactionBoundary(t *testing.T) {
	f := newFakeEsplora(t)
	f.onText("/tx/"+testTxID+"/hex", "01020304")
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))
	if rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/"+testTxID+"/raw", ""); rec.Code != 200 {
		t.Fatalf("raw transaction unavailable: %d", rec.Code)
	}
	if rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/not-a-txid/raw", ""); rec.Code != 400 {
		t.Fatalf("invalid identifier accepted: %d", rec.Code)
	}
	f.onText("/tx/"+testTxID+"/hex", "not hex")
	if rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/"+testTxID+"/raw", ""); rec.Code != 503 {
		t.Fatalf("malformed raw transaction accepted: %d", rec.Code)
	}
	if rec := do(t, router, http.MethodGet, "/v1/btc/testnet4/tx/"+testTxID+"/raw", ""); rec.Code != 404 {
		t.Fatalf("wrong configured network accepted: %d", rec.Code)
	}
}

func TestDiscoveryRejectsNullAndNegativeHeight(t *testing.T) {
	f := newFakeEsplora(t)
	f.onText("/blocks/tip/height", "-1")
	if _, err := f.service(NetworkMainnet, 1, 500).esplora.GetTipHeight(context.Background()); err == nil {
		t.Fatal("negative height accepted")
	}
	f.onText("/address/"+testMainnetAddr+"/txs", "null")
	if _, err := f.service(NetworkMainnet, 1, 500).esplora.GetAddressTxs(context.Background(), testMainnetAddr, ""); err == nil {
		t.Fatal("null history accepted as unused")
	}
	f.onText("/address/"+testMainnetAddr+"/utxo", "null")
	if _, err := f.service(NetworkMainnet, 1, 500).esplora.GetAddressUTXOs(context.Background(), testMainnetAddr); err == nil {
		t.Fatal("null UTXOs accepted as empty")
	}
}

func TestDiscoveryIncludesCoinbaseAndDoesNotHideProviderFailure(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/address/"+testMainnetAddr+"/txs", []EsploraTx{{TxID: testTxID, Vin: []EsploraVin{{IsCoinbase: true}}}})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))
	if rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/used", ""); rec.Code != 200 || decodeJSON(t, rec)["used"] != true {
		t.Fatal("coinbase history was lost")
	}
	f.on("/address/"+testMainnetAddr+"/txs", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "offline", 503) })
	if rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/used", ""); rec.Code != 503 {
		t.Fatalf("provider failure was hidden: %d", rec.Code)
	}
}
