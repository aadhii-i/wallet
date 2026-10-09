// Package config loads the wallet-api configuration from environment
// variables into a typed struct. No secret ever has a hardcoded default in
// production mode; see Validate.
package config

import (
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

type Env string

const (
	EnvDevelopment Env = "development"
	EnvProduction  Env = "production"
)

type StoreKind string

const (
	StoreMemory   StoreKind = "memory"
	StorePostgres StoreKind = "postgres"
)

type HistoryProviderKind string

const (
	HistoryScanner HistoryProviderKind = "scanner"
	HistoryAlchemy HistoryProviderKind = "alchemy"
	HistoryNone    HistoryProviderKind = "none"
)

type PriceProviderKind string

const (
	PriceStatic    PriceProviderKind = "static"
	PriceCoingecko PriceProviderKind = "coingecko"
)

// RPCUpstream is one configured upstream URL for a chain, with an optional
// human-readable name used only in logs/metrics (never the URL itself).
type RPCUpstream struct {
	Name string
	URL  string
}

type Config struct {
	AppEnv         Env
	HTTPAddr       string
	MetricsAddr    string
	AllowedOrigins []string

	Store          StoreKind
	DatabaseURL    string
	MigrateOnStart bool

	RedisURL string

	// TrustedProxies is the set of CIDRs (from TRUSTED_PROXIES) allowed to
	// set X-Forwarded-For. If a request's immediate peer is not in this
	// list, X-Forwarded-For is ignored entirely and the TCP peer address is
	// used, so an untrusted client cannot spoof its rate-limit/IP-hash key.
	TrustedProxies []*net.IPNet

	CookieSecure bool

	DevKeyDir string

	CSRFKey   []byte
	IPHashKey []byte

	EVMRPC              map[int64][]RPCUpstream
	EnableLocalNetworks bool
	HistoryProvider     map[int64]HistoryProviderKind

	PriceProvider   PriceProviderKind
	CoingeckoAPIKey string

	OTLPEndpoint string
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func getbool(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// Load reads configuration from the environment. It does not fail on
// missing optional values; call Validate to enforce production invariants.
func Load() (*Config, error) {
	cfg := &Config{
		AppEnv:              Env(getenv("APP_ENV", string(EnvDevelopment))),
		HTTPAddr:            getenv("HTTP_ADDR", ":8080"),
		MetricsAddr:         getenv("METRICS_ADDR", ":9090"),
		Store:               StoreKind(getenv("STORE", string(StoreMemory))),
		DatabaseURL:         getenv("DATABASE_URL", ""),
		MigrateOnStart:      getbool("MIGRATE_ON_START", false),
		RedisURL:            getenv("REDIS_URL", ""),
		CookieSecure:        getbool("COOKIE_SECURE", true),
		DevKeyDir:           getenv("DEV_KEY_DIR", "./.dev-keys"),
		EnableLocalNetworks: getbool("ENABLE_LOCAL_NETWORKS", true),
		PriceProvider:       PriceProviderKind(getenv("PRICE_PROVIDER", string(PriceStatic))),
		CoingeckoAPIKey:     getenv("COINGECKO_API_KEY", ""),
		OTLPEndpoint:        getenv("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
	}
	if cfg.AppEnv == EnvDevelopment {
		// default local dev origin
	}
	origins := getenv("ALLOWED_ORIGINS", "http://localhost:3000")
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
		}
	}

	if v := getenv("CSRF_KEY", ""); v != "" {
		cfg.CSRFKey = []byte(v)
	}
	if v := getenv("IP_HASH_KEY", ""); v != "" {
		cfg.IPHashKey = []byte(v)
	}

	for _, cidr := range strings.Split(getenv("TRUSTED_PROXIES", ""), ",") {
		cidr = strings.TrimSpace(cidr)
		if cidr == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(cidr); err == nil {
			cfg.TrustedProxies = append(cfg.TrustedProxies, n)
		}
	}

	cfg.EVMRPC = map[int64][]RPCUpstream{}
	cfg.HistoryProvider = map[int64]HistoryProviderKind{}

	// Well-known chain ids we look for EVM_RPC_<chainId> on.
	knownChains := []int64{1, 11155111, 8453, 42161, 137, 31337}
	for _, envKV := range os.Environ() {
		parts := strings.SplitN(envKV, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key, val := parts[0], parts[1]
		if strings.HasPrefix(key, "EVM_RPC_") {
			idStr := strings.TrimPrefix(key, "EVM_RPC_")
			chainID, err := strconv.ParseInt(idStr, 10, 64)
			if err != nil {
				continue
			}
			cfg.EVMRPC[chainID] = parseUpstreams(val)
			found := false
			for _, k := range knownChains {
				if k == chainID {
					found = true
				}
			}
			if !found {
				knownChains = append(knownChains, chainID)
			}
		}
		if strings.HasPrefix(key, "HISTORY_PROVIDER_") {
			idStr := strings.TrimPrefix(key, "HISTORY_PROVIDER_")
			chainID, err := strconv.ParseInt(idStr, 10, 64)
			if err != nil {
				continue
			}
			cfg.HistoryProvider[chainID] = HistoryProviderKind(val)
		}
	}
	// defaults for history provider
	for _, chainID := range knownChains {
		if _, ok := cfg.HistoryProvider[chainID]; !ok {
			if chainID == 31337 {
				cfg.HistoryProvider[chainID] = HistoryScanner
			} else {
				cfg.HistoryProvider[chainID] = HistoryNone
			}
		}
	}

	return cfg, nil
}

func parseUpstreams(val string) []RPCUpstream {
	var out []RPCUpstream
	for i, item := range strings.Split(val, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if idx := strings.Index(item, "="); idx > 0 {
			out = append(out, RPCUpstream{Name: item[:idx], URL: item[idx+1:]})
		} else {
			out = append(out, RPCUpstream{Name: fmt.Sprintf("upstream-%d", i+1), URL: item})
		}
	}
	return out
}

// Validate enforces hard invariants, especially for production. Call this
// after Load in main(); tests may construct Config literals and skip it.
func (c *Config) Validate() error {
	var errs []string
	if c.AppEnv == EnvProduction {
		if c.Store == StoreMemory {
			errs = append(errs, "STORE=memory is refused when APP_ENV=production")
		}
		if c.Store == StorePostgres && c.DatabaseURL == "" {
			errs = append(errs, "DATABASE_URL is required when STORE=postgres")
		}
		if len(c.CSRFKey) == 0 {
			errs = append(errs, "CSRF_KEY is required in production")
		}
		if len(c.IPHashKey) == 0 {
			errs = append(errs, "IP_HASH_KEY is required in production")
		}
		if !c.CookieSecure {
			errs = append(errs, "COOKIE_SECURE=false is refused in production")
		}
	}
	if len(errs) > 0 {
		sort.Strings(errs)
		return fmt.Errorf("invalid configuration: %s", strings.Join(errs, "; "))
	}
	return nil
}

// AccessCookieName returns the cookie name used for the access token,
// depending on whether Secure cookies are enabled (the __Host- prefix
// requires Secure, Path=/ and no Domain attribute).
func (c *Config) AccessCookieName() string {
	if c.CookieSecure {
		return "__Host-qd_at"
	}
	return "qd_at"
}

func (c *Config) RefreshCookieName() string {
	if c.CookieSecure {
		return "__Host-qd_rt"
	}
	return "qd_rt"
}
