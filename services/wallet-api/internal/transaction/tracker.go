// Package transaction implements client-broadcast transaction tracking:
// registration (idempotent on networkId+hash), status queries with events,
// and a background tracker goroutine that polls receipts (spec §16, §9.4).
package transaction

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/qdwallet/wallet-api/internal/platform/metrics"
	"github.com/qdwallet/wallet-api/internal/store"
)

// Receipt is the minimal shape the tracker needs from eth_getTransactionReceipt.
type Receipt struct {
	Status      uint64 // 1 = success, 0 = failed
	BlockNumber uint64
}

// ChainClient is the read-only view of a chain the tracker needs. The real
// implementation is backed by the RPC provider pool (internal/rpc); tests
// use a fake.
type ChainClient interface {
	// GetTransactionReceipt returns (nil, nil) if the receipt does not exist
	// yet (transaction still pending), a non-nil receipt if mined, or an
	// error for transport/RPC failures.
	GetTransactionReceipt(ctx context.Context, networkID, hash string) (*Receipt, error)
	// GetTransactionCount returns the account's transaction count
	// ("nonce") at the latest block.
	GetTransactionCount(ctx context.Context, networkID, address string) (uint64, error)
}

const (
	pollInterval = 3 * time.Second
	minBackoff   = 3 * time.Second
	maxBackoff   = 30 * time.Second
	droppedAfter = 30 * time.Minute
)

// Tracker polls ChainClient for receipts of pending transactions and
// records status transitions.
type Tracker struct {
	store  store.Store
	client ChainClient
	logger *slog.Logger

	mu        sync.Mutex
	nextCheck map[uuid.UUID]time.Time
	backoff   map[uuid.UUID]time.Duration
}

func NewTracker(st store.Store, client ChainClient, logger *slog.Logger) *Tracker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Tracker{
		store:     st,
		client:    client,
		logger:    logger,
		nextCheck: map[uuid.UUID]time.Time{},
		backoff:   map[uuid.UUID]time.Duration{},
	}
}

// Run polls every pollInterval until ctx is cancelled.
func (t *Tracker) Run(ctx context.Context) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.Tick(ctx)
		}
	}
}

// Tick runs one polling pass over every pending transaction, honoring each
// transaction's individual backoff schedule. It is exported so tests can
// drive it deterministically without real timers.
func (t *Tracker) Tick(ctx context.Context) {
	pending, err := t.store.Transactions().ListPending(ctx)
	if err != nil {
		t.logger.Error("tracker: list pending failed", slog.String("error", err.Error()))
		return
	}
	now := time.Now().UTC()
	for _, tx := range pending {
		t.mu.Lock()
		due := t.nextCheck[tx.ID]
		t.mu.Unlock()
		if !due.IsZero() && now.Before(due) {
			continue
		}
		t.checkOne(ctx, tx, now)
	}
}

func (t *Tracker) checkOne(ctx context.Context, tx *store.Transaction, now time.Time) {
	receipt, err := t.client.GetTransactionReceipt(ctx, tx.NetworkID, tx.Hash)
	if err != nil {
		t.scheduleBackoff(tx.ID, now)
		return
	}
	if receipt != nil {
		t.finalize(ctx, tx, receipt)
		return
	}

	// No receipt yet. After droppedAfter, check whether the nonce has
	// already been consumed by another transaction (replacement) or the
	// account's nonce has simply moved on without ours ever landing
	// (dropped).
	if tx.Nonce != nil && now.Sub(tx.CreatedAt) > droppedAfter {
		count, err := t.client.GetTransactionCount(ctx, tx.NetworkID, tx.From)
		if err == nil && count > uint64(*tx.Nonce) {
			t.transition(ctx, tx, store.TxReplaced, nil)
			return
		}
	}
	t.scheduleBackoff(tx.ID, now)
}

func (t *Tracker) scheduleBackoff(id uuid.UUID, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	cur := t.backoff[id]
	if cur == 0 {
		cur = minBackoff
	} else {
		cur *= 2
		if cur > maxBackoff {
			cur = maxBackoff
		}
	}
	t.backoff[id] = cur
	t.nextCheck[id] = now.Add(cur)
}

func (t *Tracker) finalize(ctx context.Context, tx *store.Transaction, receipt *Receipt) {
	status := store.TxFailed
	if receipt.Status == 1 {
		status = store.TxConfirmed
	}
	blockNumber := int64(receipt.BlockNumber)
	tx.BlockNumber = &blockNumber
	t.transition(ctx, tx, status, &blockNumber)
	metrics.TxFinalStatusTotal.WithLabelValues(tx.NetworkID, string(status)).Inc()
	metrics.TxTimeToConfirm.WithLabelValues(tx.NetworkID).Observe(time.Since(tx.CreatedAt).Seconds())
}

func (t *Tracker) transition(ctx context.Context, tx *store.Transaction, newStatus store.TxStatus, blockNumber *int64) {
	oldStatus := tx.Status
	tx.Status = newStatus
	if blockNumber != nil {
		tx.BlockNumber = blockNumber
	}
	if err := t.store.Transactions().Update(ctx, tx); err != nil {
		t.logger.Error("tracker: update tx failed", slog.String("error", err.Error()))
		return
	}
	id, err := uuid.NewV7()
	if err != nil {
		id = uuid.New()
	}
	from := oldStatus
	_ = t.store.Transactions().AddEvent(ctx, &store.TransactionEvent{
		ID:            id,
		TransactionID: tx.ID,
		FromStatus:    &from,
		ToStatus:      newStatus,
		ObservedAt:    time.Now().UTC(),
	})

	t.mu.Lock()
	delete(t.nextCheck, tx.ID)
	delete(t.backoff, tx.ID)
	t.mu.Unlock()
}
