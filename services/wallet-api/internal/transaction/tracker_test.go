package transaction_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/account"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/transaction"
)

type fakeChainClient struct {
	receipts map[string]*transaction.Receipt // key: networkID+hash
	nonces   map[string]uint64               // key: networkID+address
	err      map[string]error
}

func newFakeChainClient() *fakeChainClient {
	return &fakeChainClient{
		receipts: map[string]*transaction.Receipt{},
		nonces:   map[string]uint64{},
		err:      map[string]error{},
	}
}

func (f *fakeChainClient) GetTransactionReceipt(ctx context.Context, networkID, hash string) (*transaction.Receipt, error) {
	key := networkID + "|" + hash
	if err, ok := f.err[key]; ok {
		return nil, err
	}
	return f.receipts[key], nil
}

func (f *fakeChainClient) GetTransactionCount(ctx context.Context, networkID, address string) (uint64, error) {
	return f.nonces[networkID+"|"+address], nil
}

func setupUserAndAccount(t *testing.T, st store.Store) (uuid.UUID, uuid.UUID) {
	t.Helper()
	acctSvc := account.NewService(st)
	userID := uuid.New()
	if err := st.Users().Create(context.Background(), &store.User{ID: userID, Status: store.UserActive, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	wallet, err := acctSvc.CreateWallet(context.Background(), userID, "Test")
	if err != nil {
		t.Fatal(err)
	}
	acc, err := acctSvc.CreateAccount(context.Background(), userID, wallet.ID, 0, "Account 1")
	if err != nil {
		t.Fatal(err)
	}
	// Register "0xfrom" directly (bypassing the EIP-191 proof flow, which is
	// tested separately in internal/account) so Transactions().Create's
	// "from must be a registered address" check passes in these tracker
	// tests.
	if err := st.Addresses().Create(context.Background(), &store.Address{
		ID: uuid.New(), AccountID: acc.ID, NetworkFamily: store.FamilyEVM, Address: "0xfrom", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	return userID, acc.ID
}

func TestTrackerTransitionsToConfirmed(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	tx, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xabc", AccountID: accountID, From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "100",
	})
	if err != nil {
		t.Fatal(err)
	}

	client := newFakeChainClient()
	client.receipts["anvil|0xabc"] = &transaction.Receipt{Status: 1, BlockNumber: 42}

	tracker := transaction.NewTracker(st, client, nil)
	tracker.Tick(context.Background())

	got, events, err := txSvc.Get(context.Background(), userID, tx.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TxConfirmed {
		t.Fatalf("expected confirmed, got %s", got.Status)
	}
	if got.BlockNumber == nil || *got.BlockNumber != 42 {
		t.Fatalf("expected blockNumber 42, got %v", got.BlockNumber)
	}
	if len(events) != 1 || events[0].ToStatus != store.TxConfirmed {
		t.Fatalf("expected one confirmed event, got %v", events)
	}
}

func TestTrackerTransitionsToFailed(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	tx, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xdead", AccountID: accountID, From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1",
	})
	if err != nil {
		t.Fatal(err)
	}

	client := newFakeChainClient()
	client.receipts["anvil|0xdead"] = &transaction.Receipt{Status: 0, BlockNumber: 7}

	tracker := transaction.NewTracker(st, client, nil)
	tracker.Tick(context.Background())

	got, _, err := txSvc.Get(context.Background(), userID, tx.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TxFailed {
		t.Fatalf("expected failed, got %s", got.Status)
	}
}

func TestTrackerRemainsPendingWithoutReceipt(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	tx, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xpending", AccountID: accountID, From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1",
	})
	if err != nil {
		t.Fatal(err)
	}

	client := newFakeChainClient() // no receipt registered
	tracker := transaction.NewTracker(st, client, nil)
	tracker.Tick(context.Background())

	got, _, err := txSvc.Get(context.Background(), userID, tx.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TxPending {
		t.Fatalf("expected still pending, got %s", got.Status)
	}
}

func TestTrackerMarksReplacedAfterNonceConsumedAndTimeout(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	nonce := int64(5)
	tx, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xstale", AccountID: accountID, From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1", Nonce: &nonce,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Force the transaction to look 31 minutes old.
	stored, err := st.Transactions().Get(context.Background(), userID, tx.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored.CreatedAt = time.Now().UTC().Add(-31 * time.Minute)
	if err := st.Transactions().Update(context.Background(), stored); err != nil {
		t.Fatal(err)
	}

	client := newFakeChainClient()
	client.nonces["anvil|0xfrom"] = 6 // nonce already consumed by something else

	tracker := transaction.NewTracker(st, client, nil)
	tracker.Tick(context.Background())

	got, _, err := txSvc.Get(context.Background(), userID, tx.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.TxReplaced {
		t.Fatalf("expected replaced, got %s", got.Status)
	}
}

func TestCreateTransactionIsIdempotentOnNetworkAndHash(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	in := transaction.CreateInput{NetworkID: "anvil", Hash: "0xsame", AccountID: accountID, From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1"}
	tx1, err := txSvc.Create(context.Background(), userID, in)
	if err != nil {
		t.Fatal(err)
	}
	tx2, err := txSvc.Create(context.Background(), userID, in)
	if err != nil {
		t.Fatal(err)
	}
	if tx1.ID != tx2.ID {
		t.Fatalf("expected the same transaction to be returned, got %s vs %s", tx1.ID, tx2.ID)
	}
}
