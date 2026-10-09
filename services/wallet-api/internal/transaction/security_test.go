package transaction_test

import (
	"context"
	"errors"
	"testing"

	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/transaction"
)

// TestCreateRejectsUnregisteredFromAddress guards against an authenticated
// user tracking a transaction whose "from" is an address they never
// registered to the account (e.g. a victim's address), which would let them
// pollute or spoof another party's activity inside their own account.
func TestCreateRejectsUnregisteredFromAddress(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st) // registers "0xfrom" only
	txSvc := transaction.NewService(st)

	_, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xdeadbeef", AccountID: accountID,
		From: "0xnot-a-registered-address", To: "0xto", AssetID: "anvil:native", Amount: "1",
	})
	if !errors.Is(err, transaction.ErrFromAddressNotRegistered) {
		t.Fatalf("expected ErrFromAddressNotRegistered, got %v", err)
	}
}

// TestCreateAllowsRegisteredFromAddress is the positive counterpart.
func TestCreateAllowsRegisteredFromAddress(t *testing.T) {
	st := memory.New()
	userID, accountID := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	tx, err := txSvc.Create(context.Background(), userID, transaction.CreateInput{
		NetworkID: "anvil", Hash: "0xgoodtx", AccountID: accountID,
		From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1",
	})
	if err != nil {
		t.Fatalf("expected create to succeed for a registered from address, got: %v", err)
	}
	if tx.From != "0xfrom" {
		t.Fatalf("unexpected from: %s", tx.From)
	}
}

// TestSameHashDoesNotConflictAcrossUsers guards against the (network_id,
// hash) uniqueness being global: one user "reserving" a transaction hash
// under their own account must never block a different user from
// independently tracking the same on-chain hash under their own account
// (e.g. both the sender and a receiver tracking the same transfer).
func TestSameHashDoesNotConflictAcrossUsers(t *testing.T) {
	st := memory.New()
	userA, accountA := setupUserAndAccount(t, st)
	userB, accountB := setupUserAndAccount(t, st)
	txSvc := transaction.NewService(st)

	sharedHash := "0xshared-hash"
	if _, err := txSvc.Create(context.Background(), userA, transaction.CreateInput{
		NetworkID: "anvil", Hash: sharedHash, AccountID: accountA,
		From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "1",
	}); err != nil {
		t.Fatalf("user A create failed: %v", err)
	}

	txB, err := txSvc.Create(context.Background(), userB, transaction.CreateInput{
		NetworkID: "anvil", Hash: sharedHash, AccountID: accountB,
		From: "0xfrom", To: "0xto", AssetID: "anvil:native", Amount: "2",
	})
	if err != nil {
		t.Fatalf("user B create for the same hash must succeed (per-user scoped uniqueness), got: %v", err)
	}
	if txB.UserID != userB {
		t.Fatalf("expected user B's own transaction row, got owner %s", txB.UserID)
	}
}
