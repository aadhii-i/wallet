// Package config loads the wallet-api configuration from environment
// variables into a typed struct. No secret ever has a hardcoded default in
// production mode; see Validate.
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
)

type Env string

// KeyManagerKind selects where signing and encryption keys come from.
type KeyManagerKind string

const (
	// KeyManagerLocalDev generates keys into DEV_KEY_DIR (development only).
	KeyManagerLocalDev KeyManagerKind = "localdev"
	// KeyManagerEnv loads keys from JWT_SIGNING_KEY / KEY_ENCRYPTION_KEY
	// (deployment secrets) and never generates any.
	KeyManagerEnv KeyManagerKind = "env"
)

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

// Bitcoin networks wallet-api can be configured for.
const (
	BitcoinNetworkMainnet  = "mainnet"
	BitcoinNetworkTestnet4 = "testnet4"
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

	// DevCredentialBurst, when > 0, raises the per-IP bursts for
	// the unauthenticated /v1/auth/* routes so local multi-user testing can
	// register many independent devices from one machine. Refused in production.
	DevCredentialBurst int

	Store       StoreKind
	DatabaseURL string
	// StoreSnapshot (STORE_SNAPSHOT) persists the development in-memory store
	// to this file, so API restarts keep wallets, proposals and executions.
	StoreSnapshot  string
	MigrateOnStart bool

	RedisURL string

	// TrustedProxies is the set of CIDRs (from TRUSTED_PROXIES) allowed to
	// set X-Forwarded-For. If a request's immediate peer is not in this
	// list, X-Forwarded-For is ignored entirely and the TCP peer address is
	// used, so an untrusted client cannot spoof its rate-limit/IP-hash key.
	TrustedProxies []*net.IPNet

	CookieSecure bool

	DevKeyDir string
	// KeyManager (KEY_MANAGER): "env" in production (the default there),
	// "localdev" by default elsewhere.
	KeyManager KeyManagerKind
	// JWTSigningKey (JWT_SIGNING_KEY, secret): P-256 private key PEM (or
	// base64 of it) that signs access tokens. Required with KEY_MANAGER=env.
	JWTSigningKey string
	// KeyEncryptionKey (KEY_ENCRYPTION_KEY, secret, optional): base64 of 32
	// random bytes for the key manager's Encrypt/Decrypt.
	KeyEncryptionKey string

	CSRFKey   []byte
	IPHashKey []byte

	EVMRPC              map[int64][]RPCUpstream
	EnableLocalNetworks bool
	// RelayerKeys (RELAYER_PRIVATE_KEY_<chainId>, hex secp256k1) pay gas to
	// submit Raccoon-signed shared-wallet calls to QdAccount contracts. A
	// relayer key cannot move shared funds. Refused in production while the
	// on-chain Raccoon verifier is research-grade (ADR 0019).
	RelayerKeys         map[int64]string
	EnableSharedWallets bool
	// RPCBackgroundRPS (RPC_BACKGROUND_RPS) paces background RPC work
	// (chain indexing) per provider on public chains, so it
	// cannot exhaust the provider quota users and the relayer depend on.
	// 0 disables the limit. Local chains (31337) are never limited.
	RPCBackgroundRPS int64
	// GasLowBalanceWei (GAS_LOW_BALANCE_WEI_<chainId>, decimal wei) overrides
	// when a chain's gas service account is reported as low. Unset: enough to
	// set up one more wallet key and execute once at current gas prices.
	GasLowBalanceWei map[int64]string
	HistoryProvider  map[int64]HistoryProviderKind

	PriceProvider   PriceProviderKind
	CoingeckoAPIKey string

	// Bitcoin (Esplora REST API) configuration. Bitcoin support is off unless
	// BTCEsploraURL is set; see BTCEnabled.
	BTCEsploraURL    string
	BTCNetwork       string
	BTCFeeFloorSatVB int64
	BTCMaxFeeSatVB   int64

	// Hedera Mirror Node configuration. The default public testnet Mirror Node
	// is used when HederaMirrorURL is empty; see HederaEnabled.
	HederaMirrorURL string

	OTLPEndpoint string
}

func getenv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func getNonnegativeInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
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

func getint(key string, def int64) int64 {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

// Load reads configuration from the environment. It does not fail on
// missing optional values; call Validate to enforce production invariants.
func Load() (*Config, error) {
	cfg := &Config{
		AppEnv:              Env(getenv("APP_ENV", string(EnvDevelopment))),
		HTTPAddr:            getenv("HTTP_ADDR", ":8080"),
		MetricsAddr:         getenv("METRICS_ADDR", ":9090"),
		Store:               StoreKind(getenv("STORE", string(StoreMemory))),
		StoreSnapshot:       os.Getenv("STORE_SNAPSHOT"),
		EnableSharedWallets: getbool("ENABLE_SHARED_WALLETS", false),
		RPCBackgroundRPS:    getint("RPC_BACKGROUND_RPS", 3),
		DatabaseURL:         getenv("DATABASE_URL", ""),
		MigrateOnStart:      getbool("MIGRATE_ON_START", false),
		DevCredentialBurst:  getNonnegativeInt("DEV_CREDENTIAL_RATE_BURST", 0),
		RedisURL:            getenv("REDIS_URL", ""),
		CookieSecure:        getbool("COOKIE_SECURE", true),
		DevKeyDir:           getenv("DEV_KEY_DIR", "./.dev-keys"),
		EnableLocalNetworks: getbool("ENABLE_LOCAL_NETWORKS", true),
		PriceProvider:       PriceProviderKind(getenv("PRICE_PROVIDER", string(PriceStatic))),
		CoingeckoAPIKey:     getenv("COINGECKO_API_KEY", ""),
		BTCEsploraURL:       getenv("BTC_ESPLORA_URL", ""),
		BTCNetwork:          getenv("BTC_NETWORK", ""),
		BTCFeeFloorSatVB:    getint("BTC_FEE_FLOOR_SAT_VB", 1),
		BTCMaxFeeSatVB:      getint("BTC_MAX_FEE_SAT_VB", 500),
		HederaMirrorURL:     getenv("HEDERA_MIRROR_URL", ""),
		OTLPEndpoint:        getenv("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
	}
	defaultKM := KeyManagerLocalDev
	if cfg.AppEnv == EnvProduction {
		defaultKM = KeyManagerEnv
	}
	cfg.KeyManager = KeyManagerKind(getenv("KEY_MANAGER", string(defaultKM)))
	cfg.JWTSigningKey = os.Getenv("JWT_SIGNING_KEY")
	cfg.KeyEncryptionKey = os.Getenv("KEY_ENCRYPTION_KEY")
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
	cfg.RelayerKeys = map[int64]string{}
	cfg.GasLowBalanceWei = map[int64]string{}

	// Well-known chain ids we look for EVM_RPC_<chainId> on.
	knownChains := []int64{1, 11155111, 8453, 42161, 137, 31337}
	for _, envKV := range os.Environ() {
		parts := strings.SplitN(envKV, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key, val := parts[0], parts[1]
		if strings.HasPrefix(key, "RELAYER_PRIVATE_KEY_") {
			if chainID, err := strconv.ParseInt(strings.TrimPrefix(key, "RELAYER_PRIVATE_KEY_"), 10, 64); err == nil && val != "" {
				cfg.RelayerKeys[chainID] = val
			}
		}
		if strings.HasPrefix(key, "GAS_LOW_BALANCE_WEI_") {
			if chainID, err := strconv.ParseInt(strings.TrimPrefix(key, "GAS_LOW_BALANCE_WEI_"), 10, 64); err == nil && val != "" {
				cfg.GasLowBalanceWei[chainID] = val
			}
		}
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
	switch c.KeyManager {
	case KeyManagerLocalDev:
	case KeyManagerEnv:
		if strings.TrimSpace(c.JWTSigningKey) == "" {
			errs = append(errs, "JWT_SIGNING_KEY is required when KEY_MANAGER=env")
		}
	default:
		errs = append(errs, `KEY_MANAGER must be "env" or "localdev"`)
	}
	if c.AppEnv == EnvProduction {
		if c.KeyManager == KeyManagerLocalDev {
			errs = append(errs, "KEY_MANAGER=localdev is refused in production (keys must come from JWT_SIGNING_KEY)")
		}
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
		errs = append(errs, c.validateBitcoin()...)
		if c.DevCredentialBurst != 0 {
			errs = append(errs, "DEV_CREDENTIAL_RATE_BURST is a development-only setting and is refused in production")
		}
		if len(c.RelayerKeys) != 0 {
			errs = append(errs, "RELAYER_PRIVATE_KEY_* is refused in production (research-grade on-chain Raccoon verifier)")
		}
	}
	if len(errs) > 0 {
		sort.Strings(errs)
		return fmt.Errorf("invalid configuration: %s", strings.Join(errs, "; "))
	}
	return nil
}

// BTCEnabled reports whether Bitcoin support is configured. Bitcoin is off
// until an Esplora URL is provided.
func (c *Config) BTCEnabled() bool {
	return c.BTCEsploraURL != ""
}

// HederaEnabled reports whether a custom Hedera Mirror Node URL is configured.
// When false the hedera package uses the default public testnet Mirror Node.
func (c *Config) HederaEnabled() bool {
	return c.HederaMirrorURL != ""
}

// validateBitcoin enforces Bitcoin invariants in production: an Esplora URL
// must be present and must use HTTPS (mempool.space is always HTTPS; a plain
// HTTP URL would expose data in transit).
func (c *Config) validateBitcoin() []string {
	var errs []string
	if !c.BTCEnabled() {
		return nil
	}
	u, err := url.Parse(c.BTCEsploraURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		errs = append(errs, "BTC_ESPLORA_URL must be a valid https URL")
	} else if u.Scheme == "http" {
		host := u.Hostname()
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			errs = append(errs, "BTC_ESPLORA_URL must use https for a non-loopback host")
		}
	}
	if c.BTCNetwork != BitcoinNetworkMainnet && c.BTCNetwork != BitcoinNetworkTestnet4 {
		errs = append(errs, "BTC_NETWORK must be \""+BitcoinNetworkMainnet+"\" or \""+BitcoinNetworkTestnet4+"\"")
	}
	return errs
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
