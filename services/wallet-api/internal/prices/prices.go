// Package prices implements the batch USD price feed (spec D10): the
// backend fetches and caches prices for a curated list, so no third-party
// provider ever sees a per-user portfolio.
package prices

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Provider fetches USD prices for a set of price-ref ids.
type Provider interface {
	FetchPrices(ctx context.Context, ids []string) (map[string]string, error)
}

const CacheTTL = 60 * time.Second
const MaxIDs = 50

// StaticProvider returns fixed development prices; used when
// PRICE_PROVIDER=static (the default, so the service works with no
// external network access).
type StaticProvider struct {
	fixed map[string]string
}

func NewStaticProvider() *StaticProvider {
	return &StaticProvider{fixed: map[string]string{
		"ethereum":                "3000.00",
		"monero":                  "160.00",
		"usd-coin":                "1.00",
		"tether":                  "1.00",
		"dai":                     "1.00",
		"polygon-ecosystem-token": "0.50",
		"bitcoin":                 "60000.00",
	}}
}

func (s *StaticProvider) FetchPrices(ctx context.Context, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		if v, ok := s.fixed[id]; ok {
			out[id] = v
		}
	}
	return out, nil
}

// CoingeckoProvider calls the CoinGecko /api/v3/simple/price endpoint.
type CoingeckoProvider struct {
	apiKey     string
	httpClient *http.Client
	baseURL    string
}

func NewCoingeckoProvider(apiKey string) *CoingeckoProvider {
	return &CoingeckoProvider{apiKey: apiKey, httpClient: &http.Client{Timeout: 5 * time.Second}, baseURL: "https://api.coingecko.com"}
}

func (c *CoingeckoProvider) FetchPrices(ctx context.Context, ids []string) (map[string]string, error) {
	url := fmt.Sprintf("%s/api/v3/simple/price?ids=%s&vs_currencies=usd", c.baseURL, strings.Join(ids, ","))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if c.apiKey != "" {
		req.Header.Set("x-cg-demo-api-key", c.apiKey)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("prices: coingecko returned HTTP %d", resp.StatusCode)
	}
	var decoded map[string]map[string]float64
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(decoded))
	for id, v := range decoded {
		if usd, ok := v["usd"]; ok {
			out[id] = fmt.Sprintf("%.8f", usd)
		}
	}
	return out, nil
}

// CachingProvider wraps a Provider with a 60-second TTL cache per id, so
// repeated requests within the window never hit the upstream.
type CachingProvider struct {
	next Provider

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	value     string
	expiresAt time.Time
}

func NewCachingProvider(next Provider) *CachingProvider {
	return &CachingProvider{next: next, cache: map[string]cacheEntry{}}
}

func (c *CachingProvider) FetchPrices(ctx context.Context, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	var missing []string
	now := time.Now()

	c.mu.Lock()
	for _, id := range ids {
		if e, ok := c.cache[id]; ok && now.Before(e.expiresAt) {
			out[id] = e.value
		} else {
			missing = append(missing, id)
		}
	}
	c.mu.Unlock()

	if len(missing) > 0 {
		fetched, err := c.next.FetchPrices(ctx, missing)
		if err != nil {
			// Return whatever we already had cached rather than failing the
			// whole request if partial data is available.
			if len(out) > 0 {
				return out, nil
			}
			return nil, err
		}
		c.mu.Lock()
		for id, v := range fetched {
			out[id] = v
			c.cache[id] = cacheEntry{value: v, expiresAt: now.Add(CacheTTL)}
		}
		c.mu.Unlock()
	}
	return out, nil
}
