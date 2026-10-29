package prices

import (
	"context"
	"sort"
	"testing"
)

// clientPriceRefs mirrors the priceRef values the client declares for native
// assets (packages/blockchain/src/networks.ts) and curated tokens
// (packages/blockchain/src/assets.ts). FetchPrices silently omits ids it does
// not know, so a stale ref shows up as a missing fiat value rather than an
// error: that is how Polygon's POL stayed invisible while this table still
// keyed CoinGecko's deprecated "matic-network" id.
func TestStaticProviderCoversClientPriceRefs(t *testing.T) {
	refs := []string{"ethereum", "polygon-ecosystem-token", "usd-coin", "tether", "dai"}
	p := NewStaticProvider()

	got, err := p.FetchPrices(context.Background(), refs)
	if err != nil {
		t.Fatalf("FetchPrices: %v", err)
	}

	var missing []string
	for _, ref := range refs {
		if got[ref] == "" {
			missing = append(missing, ref)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("static price table has no entry for %v; add it or drop the ref from the client registry", missing)
	}
}

func TestStaticProviderOmitsUnknownRef(t *testing.T) {
	p := NewStaticProvider()
	got, err := p.FetchPrices(context.Background(), []string{"not-a-real-coin"})
	if err != nil {
		t.Fatalf("FetchPrices: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("unknown ref returned %v, want no entries", got)
	}
}
