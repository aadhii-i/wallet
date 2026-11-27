package hedera

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSharedAccountInfoKeepsThresholdKeyAndIntegerPrecision(t *testing.T) {
	body := `{"account":"0.0.777","balance":{"balance":9007199254740993,"timestamp":"1700000000.000000001"},"key":{"_type":"ProtobufEncoded","key":"2a020801"},"deleted":false,"receiver_sig_required":false}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	handlers := NewHandlers(NewService(NewMirror(MirrorConfig{BaseURL: server.URL})))
	router := chi.NewRouter()
	router.Get("/{network}/{accountId}", handlers.GetInfo)
	request := httptest.NewRequest("GET", "/testnet/0.0.777", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"tinybars":"9007199254740993"`) || !strings.Contains(response.Body.String(), `"type":"ProtobufEncoded"`) {
		t.Fatalf("wrong account snapshot: %d", response.Code)
	}
	body = strings.Replace(body, `,"deleted":false`, "", 1)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 503 {
		t.Fatal("incomplete account accepted")
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/mainnet/0.0.777", nil))
	if response.Code != 404 {
		t.Fatal("mainnet enabled")
	}
}

func TestSharedReceiptLookupNeverTreatsAbsenceAsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transactions/0.0.777-1700000000-000000001" || r.URL.RawQuery != "nonce=0" {
			t.Error("incorrect transaction scope")
		}
		_, _ = w.Write([]byte(`{"transactions":[{"transaction_id":"0.0.777-1700000000-000000001","result":"DUPLICATE_TRANSACTION"},{"transaction_id":"0.0.777-1700000000-000000001","result":"SUCCESS","charged_tx_fee":1000,"consensus_timestamp":"1700000001.000000001","entity_id":"0.0.778","memo_base64":"b3BlcmF0aW9uLWJvdW5k"}]}`))
	}))
	defer server.Close()
	handlers := NewHandlers(NewService(NewMirror(MirrorConfig{BaseURL: server.URL})))
	router := chi.NewRouter()
	router.Get("/{network}/{transactionId}", handlers.GetTransaction)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/testnet/0.0.777@1700000000.000000001", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"result":"SUCCESS"`) || !strings.Contains(response.Body.String(), `"intentMemo":"operation-bound"`) {
		t.Fatal("receipt selection failed")
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/testnet/not-a-transaction", nil))
	if response.Code != 400 {
		t.Fatal("invalid identifier accepted")
	}
}
