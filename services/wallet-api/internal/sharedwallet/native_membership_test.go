package sharedwallet

import (
	"errors"
	"github.com/qdwallet/wallet-api/internal/store"
	"testing"
)

func TestNativeCustodyBlocksImmediateMembershipChanges(t *testing.T) {
	e := newEnv(t)
	wid, users := e.wallet(3)
	_, code, err := e.svc.CreateInvitation(ctx, users[0].p, wid, "pending before native custody")
	if err != nil {
		t.Fatal(err)
	}
	before, err := e.st.SharedWallets().GetWallet(ctx, wid)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.st.SharedWallets().LockNativeCustody(ctx, wid, before.MembershipVersion-1); !errors.Is(err, store.ErrStale) {
		t.Fatal("stale native policy locked another epoch")
	}
	if err = e.st.SharedWallets().LockNativeCustody(ctx, wid, before.MembershipVersion); err != nil {
		t.Fatal(err)
	}
	target, err := e.st.SharedWallets().GetActiveMemberByUser(ctx, wid, users[2].p.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.svc.RevokeParticipant(ctx, users[0].p, wid, target.ID); !errors.Is(err, store.ErrNativeMigrationRequired) {
		t.Fatalf("unsafe revocation: %v", err)
	}
	if _, _, err = e.svc.CreateInvitation(ctx, users[0].p, wid, "unsafe invite"); !errors.Is(err, store.ErrNativeMigrationRequired) {
		t.Fatalf("unsafe invitation: %v", err)
	}
	outsider := e.newUser("replacement member")
	if _, _, err = e.svc.AcceptInvitation(ctx, outsider.p, code, "replacement"); !errors.Is(err, store.ErrNativeMigrationRequired) {
		t.Fatalf("unsafe join: %v", err)
	}
	after, err := e.st.SharedWallets().GetWallet(ctx, wid)
	if err != nil {
		t.Fatal(err)
	}
	if after.MembershipVersion != before.MembershipVersion || !after.NativeCustodyLocked {
		t.Fatal("failed operation changed the roster")
	}
	// Existing members retain old-policy access while a replacement is prepared.
	if _, err = e.svc.GetWallet(ctx, users[2].p, wid); err != nil {
		t.Fatal("old member lost migration/recovery access")
	}
}
