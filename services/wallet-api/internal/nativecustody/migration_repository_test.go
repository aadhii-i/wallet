package nativecustody

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/qdwallet/wallet-api/internal/platform/db"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func repositoryRace(t *testing.T, repo *MigrationRepository, source, target string) {
	t.Helper()
	var winners atomic.Int32
	var wait sync.WaitGroup
	for i := 0; i < 12; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			now := time.Now().UTC()
			m := Migration{Manifest: MigrationManifest{ID: uuid.NewString(), SourceWalletID: source, TargetWalletID: target}, Status: "draft", Revision: 1, CreatedAt: now, UpdatedAt: now}
			if repo.Create(context.Background(), m) == nil {
				winners.Add(1)
			}
		}()
	}
	wait.Wait()
	if winners.Load() != 1 {
		t.Fatalf("%d conflicting migrations accepted", winners.Load())
	}
	items, err := repo.ForWallet(context.Background(), source)
	if err != nil || len(items) != 1 {
		t.Fatal("migration history mismatch", err)
	}
	m := items[0]
	saved, err := repo.Update(context.Background(), m.Manifest.ID, m.Revision, func(current *Migration) error { current.Status = "frozen"; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 {
		t.Fatal("revision not advanced")
	}
	if _, err = repo.Update(context.Background(), m.Manifest.ID, m.Revision, func(*Migration) error { return nil }); err == nil {
		t.Fatal("stale write overwrote frozen state")
	}
}
func TestMemoryMigrationRepositorySerializesAndPersists(t *testing.T) {
	repo, err := NewMigrationRepository(nil, t.TempDir()+"/migrations.json")
	if err != nil {
		t.Fatal(err)
	}
	source, target := uuid.NewString(), uuid.NewString()
	repositoryRace(t, repo, source, target)
	reopened, err := NewMigrationRepository(nil, repo.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	items, err := reopened.ForWallet(context.Background(), target)
	if err != nil || len(items) != 1 || items[0].Status != "frozen" {
		t.Fatal("snapshot did not retain frozen state", err)
	}
}
func TestPostgresMigrationRepository(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("disposable Postgres required")
	}
	if err := db.Migrate(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	user, source, target := uuid.NewString(), uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM native_wallet_migrations WHERE source_wallet_id=$1", source)
		pool.Exec(ctx, "DELETE FROM shared_wallets WHERE id IN ($1,$2)", source, target)
		pool.Exec(ctx, "DELETE FROM users WHERE id=$1", user)
		pool.Close()
	})
	if _, err = pool.Exec(ctx, "INSERT INTO users(id) VALUES($1)", user); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{source, target} {
		if _, err = pool.Exec(ctx, "INSERT INTO shared_wallets(id,name,created_by,policy_version,policy_numerator,policy_denominator,policy_rounding)VALUES($1,'migration race',$2,1,2,3,'ceil')", id, user); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := NewMigrationRepository(pool, "")
	if err != nil {
		t.Fatal(err)
	}
	repositoryRace(t, repo, source, target)
}
