package evm

import (
	"context"
	"strings"
)

// ActivityItem mirrors the OpenAPI ActivityItem schema (chain-agnostic
// enough to reuse if other chain families are added later).
type ActivityItem struct {
	Hash        string
	NetworkID   string
	Direction   string // in | out | self
	From        string
	To          string
	AssetID     string
	Amount      string
	Fee         string
	Status      string
	BlockNumber int64
	Timestamp   int64 // unix seconds
	Flags       []string
}

// HistoryProvider returns on-chain activity for a set of addresses on one
// network. Implementations: scanner (Anvil/dev, block-scan), alchemy
// (alchemy_getAssetTransfers), none (no indexing configured).
type HistoryProvider interface {
	FetchActivity(ctx context.Context, networkID string, addresses []string) ([]ActivityItem, error)
}

// NoneProvider always returns an empty result; used when no history
// provider is configured for a chain.
type NoneProvider struct{}

func (NoneProvider) FetchActivity(ctx context.Context, networkID string, addresses []string) ([]ActivityItem, error) {
	return nil, nil
}

// DetectPoisoning flags incoming zero-value transfers, and incoming token
// transfers from addresses the account never sent to whose first-4/last-4
// hex chars match an address the account HAS sent to (spec §11.5/§20 T10).
// sentTo is the set of lowercase addresses this account has ever sent
// value to (from its own outgoing activity).
func DetectPoisoning(items []ActivityItem, sentTo map[string]struct{}) []ActivityItem {
	out := make([]ActivityItem, len(items))
	copy(out, items)
	for i := range out {
		item := &out[i]
		if item.Direction != "in" {
			continue
		}
		if item.Amount == "0" {
			item.Flags = appendFlag(item.Flags, "suspected_poisoning")
			continue
		}
		from := strings.ToLower(item.From)
		if _, known := sentTo[from]; known {
			continue
		}
		if lookalikeOfAny(from, sentTo) {
			item.Flags = appendFlag(item.Flags, "suspected_poisoning")
		}
	}
	return out
}

func appendFlag(flags []string, flag string) []string {
	for _, f := range flags {
		if f == flag {
			return flags
		}
	}
	return append(flags, flag)
}

// lookalikeOfAny reports whether addr shares its first-4 and last-4 hex
// chars (after the 0x prefix) with any address in known.
func lookalikeOfAny(addr string, known map[string]struct{}) bool {
	prefix, suffix, ok := addrFourFour(addr)
	if !ok {
		return false
	}
	for k := range known {
		kp, ks, ok := addrFourFour(k)
		if !ok {
			continue
		}
		if prefix == kp && suffix == ks && !strings.EqualFold(addr, k) {
			return true
		}
	}
	return false
}

func addrFourFour(addr string) (prefix, suffix string, ok bool) {
	a := strings.ToLower(addr)
	a = strings.TrimPrefix(a, "0x")
	if len(a) != 40 {
		return "", "", false
	}
	return a[:4], a[len(a)-4:], true
}
