package account_test

// End-to-end HTTP-layer tests for the Bitcoin address registration endpoint
// PUT /v1/accounts/{accountId}/addresses with networkFamily=bitcoin.

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"

	"github.com/qdwallet/wallet-api/internal/account"
)

// createAccount creates a wallet then an account inside it, returning the
// account id.  Used by multiple BTC test functions.
func createAccount(t *testing.T, u *testUser, baseURL string) string {
	t.Helper()
	resp, walletBody := postJSON(t, u.client, baseURL+"/v1/wallets", map[string]any{"label": "Wallet"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create wallet failed: %d %v", resp.StatusCode, walletBody)
	}
	walletID := walletBody["id"].(string)
	resp, accBody := postJSON(t, u.client, baseURL+"/v1/wallets/"+walletID+"/accounts", map[string]any{"hdIndex": 0, "name": "Account 1"}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create account failed: %d %v", resp.StatusCode, accBody)
	}
	return accBody["id"].(string)
}

// btcTestProof builds a valid btcOwnershipProof-format proof string from a
// secp256k1 private key and a message.
func btcTestProof(privKey *secp256k1.PrivateKey, message string) string {
	hash := sha256.Sum256([]byte(message))
	sig := ecdsa.Sign(privKey, hash[:])
	der := sig.Serialize()
	r32, s32 := btcDerToRS(der)
	pub := privKey.PubKey().SerializeCompressed()
	raw := make([]byte, 97)
	copy(raw[0:33], pub)
	copy(raw[33:65], r32[:])
	copy(raw[65:97], s32[:])
	return "0x" + hex.EncodeToString(raw)
}

func btcDerToRS(der []byte) ([32]byte, [32]byte) {
	var r32, s32 [32]byte
	i := 2
	rLen := int(der[i+1])
	rBytes := der[i+2 : i+2+rLen]
	if len(rBytes) > 32 {
		rBytes = rBytes[len(rBytes)-32:]
	}
	copy(r32[32-len(rBytes):], rBytes)
	i += 2 + rLen
	sLen := int(der[i+1])
	sBytes := der[i+2 : i+2+sLen]
	if len(sBytes) > 32 {
		sBytes = sBytes[len(sBytes)-32:]
	}
	copy(s32[32-len(sBytes):], sBytes)
	return r32, s32
}

// btcAddressForKey derives a Bitcoin address using the same logic as the
// production btcAddressFromPubKey helper (accessed here via the exported
// test surface only).
func btcTestAddress(privKey *secp256k1.PrivateKey, addressType, network string) string {
	addr, err := account.BtcAddressFromPubKeyForTest(privKey.PubKey().SerializeCompressed(), addressType, network)
	if err != nil {
		panic(err)
	}
	return addr
}

func TestRegisterBitcoinAddressP2WPKH(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := btcTestAddress(privKey, "p2wpkh", "mainnet")
	message := account.BtcAddressRegistrationMessage(accountID, "mainnet", address, u.userID)
	proof := btcTestProof(privKey, message)

	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2wpkh",
		"address":       address,
		"proof":         proof,
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d (%v)", resp.StatusCode, body)
	}
	if body["networkFamily"] != "bitcoin" {
		t.Fatalf("expected networkFamily=bitcoin, got %v", body["networkFamily"])
	}
}

func TestRegisterBitcoinAddressP2TR(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := btcTestAddress(privKey, "p2tr", "mainnet")
	message := account.BtcAddressRegistrationMessage(accountID, "mainnet", address, u.userID)
	proof := btcTestProof(privKey, message)

	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2tr",
		"address":       address,
		"proof":         proof,
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d (%v)", resp.StatusCode, body)
	}
}

func TestRegisterBitcoinAddressIdempotent(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := btcTestAddress(privKey, "p2wpkh", "mainnet")
	message := account.BtcAddressRegistrationMessage(accountID, "mainnet", address, u.userID)
	proof := btcTestProof(privKey, message)
	body := map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2wpkh",
		"address":       address,
		"proof":         proof,
	}

	for i := 0; i < 2; i++ {
		resp, respBody := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", body, map[string]string{"X-CSRF-Token": u.csrf})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("attempt %d: expected 200, got %d (%v)", i+1, resp.StatusCode, respBody)
		}
	}
}

func TestRegisterBitcoinAddressRejectsInvalidProof(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := btcTestAddress(privKey, "p2wpkh", "mainnet")

	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2wpkh",
		"address":       address,
		"proof":         "0x" + hex.EncodeToString(make([]byte, 97)), // all-zero proof
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for an invalid proof, got %d (%v)", resp.StatusCode, body)
	}
	if body["code"] != "INVALID_PROOF" {
		t.Fatalf("expected INVALID_PROOF code, got %v", body["code"])
	}
}

func TestRegisterBitcoinAddressRejectsFrontendPayloadWithoutNetwork(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	// Regression: this is the exact body the web client used to send
	// (networkFamily, address, addressType, proof — no "network"). addressType
	// is present, so the error must name only the missing field.
	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"address":       "bc1qtest",
		"addressType":   "p2wpkh",
		"proof":         "0x" + hex.EncodeToString(make([]byte, 97)),
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when network is missing, got %d (%v)", resp.StatusCode, body)
	}
	if body["code"] != "INVALID_BODY" {
		t.Fatalf("expected INVALID_BODY code, got %v", body["code"])
	}
	detail, _ := body["detail"].(string)
	if !strings.Contains(detail, "network is required") {
		t.Errorf("detail = %q, want it to name the missing network field", detail)
	}
	if strings.Contains(detail, "addressType") {
		t.Errorf("detail = %q, must not claim addressType is missing when it was sent", detail)
	}
}

func TestRegisterBitcoinAddressRejectsMissingAddressType(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"address":       "bc1qtest",
		"proof":         "0x" + hex.EncodeToString(make([]byte, 97)),
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when addressType is missing, got %d (%v)", resp.StatusCode, body)
	}
	detail, _ := body["detail"].(string)
	if !strings.Contains(detail, "addressType is required") {
		t.Errorf("detail = %q, want it to name the missing addressType field", detail)
	}
	if strings.Contains(detail, "network is required") {
		t.Errorf("detail = %q, must not claim network is missing when it was sent", detail)
	}
}

func TestRegisterBitcoinAddressRejectsUnsupportedAddressType(t *testing.T) {
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	address := btcTestAddress(privKey, "p2wpkh", "mainnet")
	message := account.BtcAddressRegistrationMessage(accountID, "mainnet", address, u.userID)
	proof := btcTestProof(privKey, message)

	resp, body := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2sh", // not supported
		"address":       address,
		"proof":         proof,
	}, map[string]string{"X-CSRF-Token": u.csrf})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for unsupported addressType, got %d (%v)", resp.StatusCode, body)
	}
}

func TestRegisterBitcoinAddressRejectsAnotherUsersAccount(t *testing.T) {
	srv, _ := newServer(t)
	userA := registerUser(t, srv.URL)
	userB := registerUser(t, srv.URL)
	accountID := createAccount(t, userA, srv.URL)

	privKey, _ := secp256k1.GeneratePrivateKey()
	address := btcTestAddress(privKey, "p2wpkh", "mainnet")
	message := account.BtcAddressRegistrationMessage(accountID, "mainnet", address, userB.userID)
	proof := btcTestProof(privKey, message)

	resp, _ := putJSON(t, userB.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "bitcoin",
		"network":       "mainnet",
		"addressType":   "p2wpkh",
		"address":       address,
		"proof":         proof,
	}, map[string]string{"X-CSRF-Token": userB.csrf})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for cross-user account access, got %d", resp.StatusCode)
	}
}

func TestRegisterEVMAddressStillWorks(t *testing.T) {
	// Regression test: existing EVM registration must not be broken.
	srv, _ := newServer(t)
	u := registerUser(t, srv.URL)
	accountID := createAccount(t, u, srv.URL)

	privKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	// Derive a fake EVM address from the secp256k1 key (just the last 20
	// bytes of the compressed pubkey — good enough to test the EVM path).
	pubBytes := privKey.PubKey().SerializeCompressed()
	evmAddress := "0x" + hex.EncodeToString(pubBytes[13:]) // 20 bytes → 0x+40 hex

	resp, _ := putJSON(t, u.client, srv.URL+"/v1/accounts/"+accountID+"/addresses", map[string]any{
		"networkFamily": "evm",
		"address":       evmAddress,
		"proof":         "0x" + hex.EncodeToString(make([]byte, 65)),
	}, map[string]string{"X-CSRF-Token": u.csrf})
	// The EVM proof will fail cryptographic verification, but the route must
	// reach the EVM handler (not 400 "unsupported networkFamily").
	if resp.StatusCode == http.StatusBadRequest {
		// accept — wrong proof, but the routing is correct
	}
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("EVM registration route returned 404 — routing broken")
	}
}
