package btc

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

const (
	testMainnetAddr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
	testTestnetAddr = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
	testTxID        = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
)

// newBTCRouter wires the HTTP handlers the same way main.go does.
func newBTCRouter(h *Handlers) http.Handler {
	r := chi.NewRouter()
	r.Get("/v1/btc/{network}/fees", h.GetFees)
	r.Get("/v1/btc/{network}/address/{address}/utxos", h.GetUTXOs)
	r.Get("/v1/btc/{network}/address/{address}/history", h.GetHistory)
	r.Get("/v1/btc/{network}/tx/{hash}", h.GetTransaction)
	r.Post("/v1/btc/{network}/broadcast", h.Broadcast)
	return r
}

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, path, reader)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return out
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

func TestFeesEndpointShape(t *testing.T) {
	f := newFakeEsplora(t)
	f.onText("/blocks/tip/height", "800000")
	f.onJSON("/fee-estimates", map[string]float64{
		"1": 50, "6": 12, "1008": 1,
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/fees", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	fees, ok := body["fees"].(map[string]any)
	if !ok {
		t.Fatalf("expected a fees object, got %s", rec.Body.String())
	}
	for _, key := range []string{"low", "market", "aggressive", "tipHeight", "quotedAt"} {
		if _, ok := fees[key]; !ok {
			t.Fatalf("missing %q in %s", key, rec.Body.String())
		}
	}
	if fees["low"].(float64) != 1 {
		t.Fatalf("expected low=1, got %v", fees["low"])
	}
	if fees["market"].(float64) != 12 {
		t.Fatalf("expected market=12, got %v", fees["market"])
	}
	if fees["aggressive"].(float64) != 50 {
		t.Fatalf("expected aggressive=50, got %v", fees["aggressive"])
	}
	if fees["tipHeight"].(float64) != 800000 {
		t.Fatalf("expected tipHeight=800000, got %v", fees["tipHeight"])
	}
}

func TestFeesAreClampedIntoTheConfiguredBand(t *testing.T) {
	f := newFakeEsplora(t)
	f.onText("/blocks/tip/height", "800000")
	// Return rates outside the [2, 500] band.
	f.onJSON("/fee-estimates", map[string]float64{
		"1": 5000, "6": 0, "1008": 50000,
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 2, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/fees", "")
	fees := decodeJSON(t, rec)["fees"].(map[string]any)
	if fees["low"].(float64) != 500 {
		t.Fatalf("expected low clamped to max=500, got %v", fees["low"])
	}
	if fees["market"].(float64) != 2 {
		t.Fatalf("expected market clamped to floor=2, got %v", fees["market"])
	}
	if fees["aggressive"].(float64) != 500 {
		t.Fatalf("expected aggressive clamped to max=500, got %v", fees["aggressive"])
	}
}

func TestFeesFallBackToTheFloorWhenEstimatesUnavailable(t *testing.T) {
	f := newFakeEsplora(t)
	f.onText("/blocks/tip/height", "800000")
	// fee-estimates returns an error.
	f.on("/fee-estimates", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 3, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/fees", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 even when estimates are unavailable, got %d", rec.Code)
	}
	fees := decodeJSON(t, rec)["fees"].(map[string]any)
	for _, key := range []string{"low", "market", "aggressive"} {
		if fees[key].(float64) != 3 {
			t.Fatalf("expected %s to fall back to floor=3, got %v", key, fees[key])
		}
	}
}

// ---------------------------------------------------------------------------
// UTXOs
// ---------------------------------------------------------------------------

func TestUTXOsEndpointShape(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/address/"+testMainnetAddr+"/utxo", []EsploraUTXO{
		{
			TxID:  testTxID,
			Vout:  0,
			Value: 123456,
			Status: struct {
				Confirmed   bool  `json:"confirmed"`
				BlockHeight int64 `json:"block_height"`
				BlockTime   int64 `json:"block_time"`
			}{Confirmed: true, BlockHeight: 799900},
		},
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/utxos", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	utxos, ok := body["utxos"].([]any)
	if !ok || len(utxos) != 1 {
		t.Fatalf("expected one utxo, got %s", rec.Body.String())
	}
	u := utxos[0].(map[string]any)
	if u["value"].(string) != "123456" {
		t.Fatalf("unexpected value: %v", u["value"])
	}
	if u["txid"] != testTxID {
		t.Fatalf("unexpected txid: %v", u["txid"])
	}
	if u["blockHeight"].(float64) != 799900 {
		t.Fatalf("expected blockHeight=799900, got %v", u["blockHeight"])
	}
}

func TestUTXOsEmptyForUnknownAddress(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/address/"+testMainnetAddr+"/utxo", []EsploraUTXO{})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/utxos", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	utxos := decodeJSON(t, rec)["utxos"].([]any)
	if len(utxos) != 0 {
		t.Fatalf("expected empty utxo list, got %d items", len(utxos))
	}
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

func TestHistoryEndpointShape(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/address/"+testMainnetAddr+"/txs", []EsploraTx{
		{
			TxID: testTxID,
			Fee:  284,
			Vin: []EsploraVin{{
				TxID: "prev1",
				Vout: 0,
				Prevout: &EsploraVout{
					ScriptpubkeyAddress: "bc1qother",
					Value:               350000,
				},
			}},
			Vout: []EsploraVout{{
				ScriptpubkeyAddress: testMainnetAddr,
				Value:               250000,
			}},
			Status: EsploraTxStatus{
				Confirmed:   true,
				BlockHeight: 799990,
				BlockTime:   1700000000,
			},
		},
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/history", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	items, ok := body["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("expected one activity item, got %s", rec.Body.String())
	}
	item := items[0].(map[string]any)
	if item["hash"] != testTxID {
		t.Fatalf("unexpected hash: %v", item["hash"])
	}
	if item["networkId"] != "btc-mainnet" {
		t.Fatalf("unexpected networkId: %v", item["networkId"])
	}
	if item["direction"] != "in" {
		t.Fatalf("expected direction=in (address is in vout only), got %v", item["direction"])
	}
	if item["status"] != "confirmed" {
		t.Fatalf("unexpected status: %v", item["status"])
	}
	if item["amount"].(string) != "250000" {
		t.Fatalf("unexpected amount: %v", item["amount"])
	}
	if _, ok := item["flags"].([]any); !ok {
		t.Fatalf("flags must be an array, got %T", item["flags"])
	}
}

func TestHistoryDirectionOut(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/address/"+testMainnetAddr+"/txs", []EsploraTx{
		{
			TxID: testTxID,
			Fee:  200,
			Vin: []EsploraVin{{
				Prevout: &EsploraVout{
					ScriptpubkeyAddress: testMainnetAddr, // spending from our address
					Value:               100000,
				},
			}},
			Vout: []EsploraVout{{
				ScriptpubkeyAddress: "bc1qrecipient",
				Value:               99800,
			}},
			Status: EsploraTxStatus{Confirmed: true, BlockHeight: 799000, BlockTime: 1699000000},
		},
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testMainnetAddr+"/history", "")
	items := decodeJSON(t, rec)["items"].([]any)
	item := items[0].(map[string]any)
	if item["direction"] != "out" {
		t.Fatalf("expected direction=out, got %v", item["direction"])
	}
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

func TestTransactionEndpointShape(t *testing.T) {
	f := newFakeEsplora(t)
	f.onJSON("/tx/"+testTxID, &EsploraTx{
		TxID: testTxID,
		Fee:  100000,
		Vin: []EsploraVin{{
			Prevout: &EsploraVout{
				ScriptpubkeyAddress: testMainnetAddr,
				Value:               500000,
			},
		}},
		Vout: []EsploraVout{{
			ScriptpubkeyAddress: testMainnetAddr,
			Value:               400000,
		}},
		Status: EsploraTxStatus{
			Confirmed:   true,
			BlockHeight: 799990,
			BlockTime:   1700000500,
		},
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/"+testTxID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	if body["txid"] != testTxID {
		t.Fatalf("unexpected txid: %v", body["txid"])
	}
	if body["status"] != "confirmed" {
		t.Fatalf("unexpected status: %v", body["status"])
	}
	if body["value"].(string) != "400000" {
		t.Fatalf("unexpected value: %v", body["value"])
	}
	if body["fee"].(string) != "100000" {
		t.Fatalf("unexpected fee: %v", body["fee"])
	}
	if body["blockHeight"].(float64) != 799990 {
		t.Fatalf("unexpected blockHeight: %v", body["blockHeight"])
	}
	inputs, ok := body["inputs"].([]any)
	if !ok || len(inputs) != 1 {
		t.Fatalf("expected one input, got %s", rec.Body.String())
	}
}

func TestUnknownTransactionReturnsNotFound(t *testing.T) {
	f := newFakeEsplora(t)
	f.on("/tx/"+testTxID, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/"+testTxID, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

func TestBroadcastReturnsTheTxID(t *testing.T) {
	f := newFakeEsplora(t)
	f.on("/tx", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "wrong method", http.StatusMethodNotAllowed)
			return
		}
		body := readBody(r)
		if body == "" {
			http.Error(w, "empty body", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(testTxID))
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodPost, "/v1/btc/mainnet/broadcast", `{"raw":"0100"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	if body["txid"] != testTxID {
		t.Fatalf("unexpected txid: %v", body["txid"])
	}
}

func TestBroadcastValidatesTheRawTransaction(t *testing.T) {
	f, svc := stdFakeEsplora(t)
	_ = f
	router := newBTCRouter(NewHandlers(svc))

	cases := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"odd length", "abc"},
		{"not hex", "zzzz"},
		{"too large", strings.Repeat("ab", 60_000)},
	}
	for _, tc := range cases {
		rec := do(t, router, http.MethodPost, "/v1/btc/mainnet/broadcast", `{"raw":"`+tc.raw+`"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
	}
}

func TestBroadcastRejectionIsSanitized(t *testing.T) {
	f := newFakeEsplora(t)
	f.on("/tx", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad-txns-inputs-missingorspent internal wallet detail", http.StatusBadRequest)
	})
	router := newBTCRouter(NewHandlers(f.service(NetworkMainnet, 1, 500)))

	rec := do(t, router, http.MethodPost, "/v1/btc/mainnet/broadcast", `{"raw":"0100"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (%s)", rec.Code, rec.Body.String())
	}
	problem := decodeJSON(t, rec)
	if problem["code"] != "INVALID_TX" {
		t.Fatalf("expected INVALID_TX, got %v", problem["code"])
	}
	if strings.Contains(rec.Body.String(), "internal wallet detail") {
		t.Fatalf("rejection reason leaked to client: %s", rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Routing guards
// ---------------------------------------------------------------------------

func TestMismatchedNetworkReturnsNotFound(t *testing.T) {
	f, svc := stdFakeEsplora(t)
	_ = f
	router := newBTCRouter(NewHandlers(svc))

	// Service is mainnet; asking for testnet4 must 404.
	rec := do(t, router, http.MethodGet, "/v1/btc/testnet4/fees", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for wrong network, got %d", rec.Code)
	}
	rec = do(t, router, http.MethodGet, "/v1/btc/regtest/fees", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown network, got %d", rec.Code)
	}
}

func TestBitcoinNotConfiguredReturnsNotFound(t *testing.T) {
	router := newBTCRouter(NewHandlers(nil))
	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/fees", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when Bitcoin is not configured, got %d", rec.Code)
	}
}

func TestInvalidAddressReturnsBadRequest(t *testing.T) {
	f, svc := stdFakeEsplora(t)
	_ = f
	router := newBTCRouter(NewHandlers(svc))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/address/not-an-address/utxos", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an invalid address, got %d", rec.Code)
	}
	problem := decodeJSON(t, rec)
	if problem["code"] != "INVALID_ADDRESS" {
		t.Fatalf("expected INVALID_ADDRESS, got %v", problem["code"])
	}

	// A testnet address on mainnet is also rejected.
	rec = do(t, router, http.MethodGet, "/v1/btc/mainnet/address/"+testTestnetAddr+"/utxos", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a cross-network address, got %d", rec.Code)
	}
}

func TestInvalidTxIDReturnsBadRequest(t *testing.T) {
	f, svc := stdFakeEsplora(t)
	_ = f
	router := newBTCRouter(NewHandlers(svc))

	rec := do(t, router, http.MethodGet, "/v1/btc/mainnet/tx/abc", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a malformed txid, got %d", rec.Code)
	}
	if decodeJSON(t, rec)["code"] != "INVALID_TXID" {
		t.Fatalf("expected INVALID_TXID, got %s", rec.Body.String())
	}
}
