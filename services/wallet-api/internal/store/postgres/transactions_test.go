package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
)

// The personal-wallet path the web app exercises: wallet, account, address,
// a tracked transaction, and the security-event feed.
func TestPostgresTrackedSendAndSecurityEvents(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	user, wallet, account := uuid.New(), uuid.New(), uuid.New()
	idx := int64(0)
	must := func(what string, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	must("user", st.Users().Create(ctx, &store.User{ID: user, Status: store.UserActive, CreatedAt: now}))
	must("wallet", st.Wallets().Create(ctx, &store.Wallet{ID: wallet, UserID: user, Label: "W", DefaultSigningMode: store.SigningHD, CreatedAt: now}))
	must("account", st.Accounts().Create(ctx, &store.Account{ID: account, WalletID: wallet, UserID: user, HDIndex: &idx, Name: "Account 1", SigningMode: store.SigningHD, CreatedAt: now}))
	from := "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	must("address", st.Addresses().Create(ctx, &store.Address{ID: uuid.New(), AccountID: account, NetworkFamily: store.FamilyEVM, Address: from, CreatedAt: now}))

	hash := "0x" + uuid.NewString()[:8] + "00000000000000000000000000000000000000000000000000000000"
	if _, err := st.Transactions().GetByNetworkAndHash(ctx, user, "anvil", hash); err == nil {
		t.Fatal("found a transaction before creating it")
	} else if err != store.ErrNotFound {
		t.Fatalf("lookup before create: %v", err)
	}
	_, err := st.Accounts().Get(ctx, user, account)
	must("account get", err)
	addrs, err := st.Addresses().ListByAccount(ctx, user, account)
	must("addresses", err)
	if len(addrs) != 1 {
		t.Fatalf("addresses: %d", len(addrs))
	}
	nonce := int64(3)
	must("transaction", st.Transactions().Create(ctx, &store.Transaction{
		ID: uuid.New(), UserID: user, AccountID: account, NetworkID: "anvil", Hash: hash, From: from,
		To: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", AssetID: "eth", Amount: "50000000000000000", Nonce: &nonce,
		Status: store.TxPending, Origin: store.OriginWallet, CreatedAt: now, UpdatedAt: now,
	}))
	got, err := st.Transactions().GetByNetworkAndHash(ctx, user, "anvil", hash)
	must("transaction get", err)
	if got.Amount != "50000000000000000" || got.Nonce == nil || *got.Nonce != 3 {
		t.Fatalf("transaction round trip: %+v", got)
	}

	dev := uuid.New()
	must("device", st.Devices().Create(ctx, &store.Device{
		ID: dev, UserID: user, PublicKey: []byte("device-pubkey-" + dev.String()), Platform: store.PlatformWeb,
		Label: "Chrome", LastSeenAt: now, CreatedAt: now,
	}))
	must("security event", st.SecurityEvents().Create(ctx, &store.SecurityEvent{
		ID: uuid.New(), UserID: user, DeviceID: &dev, Type: "device_registered", Severity: store.SeverityInfo,
		IPHash: "h", Metadata: map[string]any{"platform": "web"}, CreatedAt: now,
	}))
	evs, err := st.SecurityEvents().ListByUser(ctx, user, 50)
	must("security events", err)
	if len(evs) != 1 || evs[0].Type != "device_registered" {
		t.Fatalf("security events: %d", len(evs))
	}
}
