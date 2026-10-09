package memory_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
)

// TestConcurrentClaimRotationOnlyOneWinner races many goroutines claiming
// the same refresh-token hash and asserts exactly one succeeds, closing the
// check-then-act race that existed when Get and MarkRotated were separate
// calls.
func TestConcurrentClaimRotationOnlyOneWinner(t *testing.T) {
	st := memory.New()
	ctx := context.Background()
	sessionID := uuid.New()
	hash := []byte("shared-refresh-token-hash")

	if err := st.RefreshTokens().Create(ctx, &store.RefreshToken{
		Hash: hash, SessionID: sessionID, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	const n = 50
	var wg sync.WaitGroup
	var claimedCount int32
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, claimed, err := st.RefreshTokens().ClaimRotation(ctx, hash)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if claimed {
				atomic.AddInt32(&claimedCount, 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if claimedCount != 1 {
		t.Fatalf("expected exactly 1 winner among %d concurrent claims, got %d", n, claimedCount)
	}
}

// TestConcurrentClaimChallengeOnlyOneWinner is the same property for
// challenge single-use redemption.
func TestConcurrentClaimChallengeOnlyOneWinner(t *testing.T) {
	st := memory.New()
	ctx := context.Background()
	id := uuid.New()
	if err := st.Challenges().Create(ctx, &store.Challenge{
		ID: id, PublicKey: []byte("pk"), Nonce: "n", Message: "m",
		Origin: "http://localhost:3000", ClientType: "web",
		ExpiresAt: time.Now().Add(time.Minute), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	const n = 50
	var wg sync.WaitGroup
	var claimedCount int32
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := st.Challenges().ClaimChallenge(ctx, id)
			if err == nil {
				atomic.AddInt32(&claimedCount, 1)
			} else if err != store.ErrConflict {
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if claimedCount != 1 {
		t.Fatalf("expected exactly 1 winner among %d concurrent claims, got %d", n, claimedCount)
	}
}
