package memory

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/qdwallet/wallet-api/internal/store"
)

type chainIndexStore struct {
	mu        sync.Mutex
	transfers map[string]*store.ChainTransfer // "chain/hash/logIndex"
	cursors   map[string]*store.IndexCursor   // "chain/address"
	parent    *Store
}

func newChainIndexStore(parent *Store) *chainIndexStore {
	return &chainIndexStore{transfers: map[string]*store.ChainTransfer{}, cursors: map[string]*store.IndexCursor{}, parent: parent}
}

func transferKey(t *store.ChainTransfer) string {
	return fmt.Sprintf("%d/%s/%d", t.ChainID, strings.ToLower(t.TxHash), t.LogIndex)
}

func (s *chainIndexStore) RecordTransfer(_ context.Context, t *store.ChainTransfer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := transferKey(t)
	if _, ok := s.transfers[k]; ok {
		return nil
	}
	c := *t
	s.transfers[k] = &c
	return nil
}

func (s *chainIndexStore) ListTransfers(_ context.Context, chainID int64, addresses []string, limit int) ([]*store.ChainTransfer, error) {
	set := map[string]bool{}
	for _, a := range addresses {
		set[strings.ToLower(a)] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*store.ChainTransfer
	for _, t := range s.transfers {
		if t.ChainID == chainID && (set[t.From] || set[t.To] || set[t.TxFrom]) {
			c := *t
			out = append(out, &c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BlockNumber != out[j].BlockNumber {
			return out[i].BlockNumber > out[j].BlockNumber
		}
		if out[i].TxHash != out[j].TxHash {
			return out[i].TxHash < out[j].TxHash
		}
		return out[i].LogIndex < out[j].LogIndex
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *chainIndexStore) GetCursor(_ context.Context, chainID int64, address string) (*store.IndexCursor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cursors[fmt.Sprintf("%d/%s", chainID, strings.ToLower(address))]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *c
	return &cp, nil
}

func (s *chainIndexStore) PutCursor(_ context.Context, c *store.IndexCursor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *c
	cp.Address = strings.ToLower(c.Address)
	s.cursors[fmt.Sprintf("%d/%s", c.ChainID, cp.Address)] = &cp
	return nil
}

func (s *chainIndexStore) WatchedAddresses(_ context.Context) ([]store.WatchedAddress, error) {
	seen := map[string]bool{}
	var out []store.WatchedAddress
	add := func(a, kind string) {
		a = strings.ToLower(a)
		if a == "" || seen[a] {
			return
		}
		seen[a] = true
		out = append(out, store.WatchedAddress{Address: a, Kind: kind})
	}
	as := s.parent.addresses
	as.mu.RLock()
	for _, a := range as.data {
		if a.NetworkFamily == store.FamilyEVM {
			add(a.Address, "personal")
		}
	}
	as.mu.RUnlock()
	sh := s.parent.shared
	sh.mu.Lock()
	for _, k := range sh.accountKeys {
		add(k.Address, "shared")
	}
	sh.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return out, nil
}
