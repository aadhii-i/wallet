// Postgres integration tests. These only run when TEST_DATABASE_URL is set
// (e.g. in CI with a real Postgres service, or locally against
// docker-compose). They are skipped by default so `go test ./...` never
// requires a running database.
package postgres_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/qdwallet/wallet-api/internal/platform/db"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/postgres"
)

func testStore(t *testing.T) store.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping postgres integration tests")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return postgres.New(pool)
}

func TestPostgresUserDeviceRoundTrip(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	userID := uuid.New()
	if err := st.Users().Create(ctx, &store.User{ID: userID, Status: store.UserActive, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("create user: %v", err)
	}
	got, err := st.Users().Get(ctx, userID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if got.ID != userID {
		t.Fatalf("expected %s, got %s", userID, got.ID)
	}

	deviceID := uuid.New()
	err = st.Devices().Create(ctx, &store.Device{
		ID: deviceID, UserID: userID, PublicKey: []byte("test-pubkey-1"), Platform: store.PlatformWeb,
		Label: "Test", LastSeenAt: time.Now().UTC(), CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("create device: %v", err)
	}

	// Duplicate public key must conflict.
	err = st.Devices().Create(ctx, &store.Device{
		ID: uuid.New(), UserID: userID, PublicKey: []byte("test-pubkey-1"), Platform: store.PlatformWeb,
		LastSeenAt: time.Now().UTC(), CreatedAt: time.Now().UTC(),
	})
	if err == nil {
		t.Fatal("expected conflict for duplicate device public key")
	}

	if err := st.Devices().Revoke(ctx, userID, deviceID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	d, err := st.Devices().Get(ctx, userID, deviceID)
	if err != nil {
		t.Fatalf("get device: %v", err)
	}
	if d.RevokedAt == nil {
		t.Fatal("expected device to be revoked")
	}
}

func TestPostgresIDOR(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	userA := uuid.New()
	userB := uuid.New()
	for _, u := range []uuid.UUID{userA, userB} {
		if err := st.Users().Create(ctx, &store.User{ID: u, Status: store.UserActive, CreatedAt: time.Now().UTC()}); err != nil {
			t.Fatalf("create user: %v", err)
		}
	}

	walletID := uuid.New()
	if err := st.Wallets().Create(ctx, &store.Wallet{ID: walletID, UserID: userA, Label: "A", DefaultSigningMode: store.SigningHD, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("create wallet: %v", err)
	}

	if _, err := st.Wallets().Get(ctx, userB, walletID); err == nil {
		t.Fatal("expected user B to not be able to read user A's wallet")
	}
}

func TestPostgresAuditChain(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if err := st.AuditLogs().Append(ctx, &store.AuditLog{
			ActorType: "user", ActorID: "u1", Action: "test_action", SubjectType: "wallet", SubjectID: "w1",
		}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	if err := st.AuditLogs().VerifyChain(ctx); err != nil {
		t.Fatalf("expected intact chain, got: %v", err)
	}
}
