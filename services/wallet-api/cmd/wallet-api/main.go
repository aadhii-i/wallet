// Command wallet-api is the QD Wallet backend: a non-custodial, modular
// monolith serving auth, wallet/account/address management, an EVM RPC
// proxy, transaction tracking, prices, and security events. See
// docs/api/openapi.yaml and docs/architecture/qd-wallet-v1-technical-spec.md.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/qdwallet/wallet-api/internal/account"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/platform/config"
	"github.com/qdwallet/wallet-api/internal/platform/db"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/platform/logging"
	"github.com/qdwallet/wallet-api/internal/platform/metrics"
	"github.com/qdwallet/wallet-api/internal/prices"
	"github.com/qdwallet/wallet-api/internal/rpc"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/store/postgres"
	"github.com/qdwallet/wallet-api/internal/transaction"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "wallet-api: fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}

	level := slog.LevelInfo
	if cfg.AppEnv == config.EnvDevelopment {
		level = slog.LevelDebug
	}
	logger := logging.New(level)
	slog.SetDefault(logger)

	isProduction := cfg.AppEnv == config.EnvProduction

	// --- KeyManager (§13.3) -------------------------------------------------
	km, err := security.NewLocalDevKeyManager(cfg.DevKeyDir, isProduction)
	if err != nil {
		return fmt.Errorf("key manager: %w", err)
	}

	csrfKey, err := loadOrGenerateKey(cfg, "csrf.key", cfg.CSRFKey)
	if err != nil {
		return err
	}
	ipHashKey, err := loadOrGenerateKey(cfg, "iphash.key", cfg.IPHashKey)
	if err != nil {
		return err
	}

	// --- Store ---------------------------------------------------------------
	var st store.Store
	var pgPool *pgxpool.Pool
	switch cfg.Store {
	case config.StoreMemory:
		st = memory.New()
		logger.Info("using in-memory store (not for production)")
	case config.StorePostgres:
		if cfg.MigrateOnStart {
			if err := db.Migrate(cfg.DatabaseURL); err != nil {
				return fmt.Errorf("migrate: %w", err)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		pgPool, err = db.NewPool(ctx, cfg.DatabaseURL)
		cancel()
		if err != nil {
			return fmt.Errorf("postgres: %w", err)
		}
		st = postgres.New(pgPool)
	default:
		return fmt.Errorf("unknown STORE %q", cfg.Store)
	}
	defer st.Close()

	// --- EVM network registry + RPC provider pools (§25) ---------------------
	upstreamCounts := map[int64]int{}
	pools := map[int64]*rpc.Pool{}
	for chainID, upstreams := range cfg.EVMRPC {
		if len(upstreams) == 0 {
			continue
		}
		upstreamCounts[chainID] = len(upstreams)
		var rpcUpstreams []rpc.Upstream
		for _, u := range upstreams {
			rpcUpstreams = append(rpcUpstreams, rpc.Upstream{Name: u.Name, URL: u.URL})
		}
		pools[chainID] = rpc.NewPool(chainID, rpcUpstreams, logger)
	}
	registry := evm.NewRegistry(upstreamCounts)
	rpcManager := rpc.NewManager(registry, pools)

	healthCtx, healthCancel := context.WithCancel(context.Background())
	defer healthCancel()
	for _, pool := range pools {
		pool.StartHealthChecks(healthCtx)
	}

	// --- History providers per network ----------------------------------------
	historyByNetwork := map[string]evm.HistoryProvider{}
	for chainID, kind := range cfg.HistoryProvider {
		network, ok := registry.ByChainID(chainID)
		if !ok || !network.Enabled {
			continue
		}
		pool := pools[chainID]
		switch kind {
		case config.HistoryScanner:
			if pool != nil {
				historyByNetwork[network.ID] = evm.NewScannerProvider(pool)
			}
		case config.HistoryAlchemy:
			if pool != nil {
				if caller, ok := pool.NamedCaller("alchemy"); ok {
					historyByNetwork[network.ID] = evm.NewAlchemyProvider(caller)
				}
			}
		default:
			historyByNetwork[network.ID] = evm.NoneProvider{}
		}
	}

	// --- Services --------------------------------------------------------------
	authSvc := auth.NewService(st, km)
	acctSvc := account.NewService(st)
	txSvc := transaction.NewService(st)

	var priceProvider prices.Provider
	if cfg.PriceProvider == config.PriceCoingecko {
		priceProvider = prices.NewCachingProvider(prices.NewCoingeckoProvider(cfg.CoingeckoAPIKey))
	} else {
		priceProvider = prices.NewCachingProvider(prices.NewStaticProvider())
	}

	// --- Background transaction tracker (spec §9.4) -----------------------------
	trackerCtx, trackerCancel := context.WithCancel(context.Background())
	defer trackerCancel()
	if len(pools) > 0 {
		chainClient := newChainClient(registry, pools)
		tracker := transaction.NewTracker(st, chainClient, logger)
		go tracker.Run(trackerCtx)
	}

	// --- HTTP handlers -----------------------------------------------------------
	cookies := auth.CookieNames{Access: cfg.AccessCookieName(), Refresh: cfg.RefreshCookieName()}
	authHandlers := auth.NewHandlers(authSvc, cfg.AllowedOrigins, cfg.CookieSecure, cookies, csrfKey, ipHashKey, cfg.TrustedProxies)
	acctHandlers := account.NewHandlers(acctSvc, st)
	txHandlers := transaction.NewHandlers(txSvc, st)
	activityHandlers := transaction.NewActivityHandlers(st, providerRegistry(historyByNetwork))
	evmHandlers := evm.NewHandlers(registry)
	rpcHandler := rpc.NewHandler(rpcManager)
	priceHandlers := prices.NewHandlers(priceProvider)
	secHandlers := security.NewHandlers(st.SecurityEvents(), principalFunc)

	sessionRateLimit := security.NewKeyedTokenBucket(20, 40)
	unauthRateLimit := security.NewKeyedTokenBucket(5, 20)
	// Stricter, dedicated limit on the two credential-issuing endpoints
	// (challenge/register): 10/min per IP, on top of the broader unauthRateLimit
	// shared by challenge/register/login/refresh.
	credentialRateLimit := security.NewKeyedTokenBucket(10.0/60.0, 10)

	r := chi.NewRouter()
	r.Use(httpx.RequestID)
	r.Use(httpx.Recover(logger))
	r.Use(httpx.AccessLog(logger))
	r.Use(httpx.BodyLimit(64 * 1024))
	r.Use(httpx.CORS(cfg.AllowedOrigins))
	r.Use(httpx.SecurityHeaders(true))

	authMW := auth.Middleware(authSvc, cookies, csrfKey)

	// Public routes
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/v1/networks", evmHandlers.ListNetworks)
	r.Get("/v1/prices", priceHandlers.GetPrices)

	r.Group(func(r chi.Router) {
		r.Use(ipRateLimitMiddleware(unauthRateLimit, cfg.TrustedProxies))
		r.Post("/v1/auth/login", authHandlers.Login)
		r.Post("/v1/auth/refresh", authHandlers.Refresh)

		r.Group(func(r chi.Router) {
			// challenge/register are the credential-issuing endpoints; hold
			// them to a tighter per-IP budget than login/refresh.
			r.Use(ipRateLimitMiddleware(credentialRateLimit, cfg.TrustedProxies))
			r.Post("/v1/auth/challenge", authHandlers.CreateChallenge)
			r.Post("/v1/auth/register", authHandlers.Register)
		})
	})

	r.Group(func(r chi.Router) {
		r.Use(authMW)
		r.Post("/v1/auth/logout", authHandlers.Logout)
		r.Get("/v1/me", authHandlers.Me)

		r.Get("/v1/devices", authHandlers.ListDevices)
		r.Patch("/v1/devices/{deviceId}", authHandlers.RenameDevice)
		r.Delete("/v1/devices/{deviceId}", authHandlers.RevokeDevice)

		r.Get("/v1/wallets", acctHandlers.ListWallets)
		r.Post("/v1/wallets", acctHandlers.CreateWallet)
		r.Post("/v1/wallets/{walletId}/accounts", acctHandlers.CreateAccount)
		r.Patch("/v1/accounts/{accountId}", acctHandlers.UpdateAccount)
		r.Put("/v1/accounts/{accountId}/addresses", acctHandlers.RegisterAddress)
		r.Get("/v1/accounts/{accountId}/activity", activityHandlers.GetActivity)

		r.Post("/v1/transactions", txHandlers.Create)
		r.Get("/v1/transactions/{transactionId}", txHandlers.Get)

		r.Get("/v1/security/events", secHandlers.ListEvents)
		r.Post("/v1/security/client-events", secHandlers.ReportClientEvent)

		r.Group(func(r chi.Router) {
			r.Use(auth.RateLimitBySession(sessionRateLimit))
			r.Post("/v1/rpc/evm/{chainId}", rpcHandler.ServeHTTP)
		})
	})

	server := &http.Server{Addr: cfg.HTTPAddr, Handler: r}
	metricsServer := &http.Server{Addr: cfg.MetricsAddr, Handler: metrics.Handler()}

	errCh := make(chan error, 2)
	go func() {
		logger.Info("http server listening", slog.String("addr", cfg.HTTPAddr))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	go func() {
		logger.Info("metrics server listening", slog.String("addr", cfg.MetricsAddr))
		if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("shutting down", slog.String("signal", sig.String()))
	case err := <-errCh:
		logger.Error("server error", slog.String("error", err.Error()))
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	_ = metricsServer.Shutdown(shutdownCtx)
	trackerCancel()
	healthCancel()

	return nil
}

// principalFunc adapts auth.FromContext to security.PrincipalFunc without
// internal/security importing internal/auth (which would cycle back).
func principalFunc(r *http.Request) (uuid.UUID, uuid.UUID, bool) {
	p := auth.FromContext(r.Context())
	if p == nil {
		return uuid.UUID{}, uuid.UUID{}, false
	}
	return p.UserID, p.DeviceID, true
}

// ipRateLimitMiddleware keys the limiter on the resolved client IP (see
// security.ClientIP): the TCP peer host by default, or the rightmost
// untrusted X-Forwarded-For hop when the peer is a configured trusted
// proxy. It never trusts X-Forwarded-For from an arbitrary caller and never
// keys on host:port (which would hand every connection its own bucket).
func ipRateLimitMiddleware(limiter security.Limiter, trustedProxies []*net.IPNet) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := security.ClientIP(r, trustedProxies)
			if !limiter.Allow(ip) {
				httpx.TooManyRequests(w, r, "RATE_LIMITED", "Too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// providerRegistry adapts a plain map to transaction.ActivityProviders.
type providerRegistry map[string]evm.HistoryProvider

func (p providerRegistry) ProviderFor(networkID string) evm.HistoryProvider {
	return p[networkID]
}

// loadOrGenerateKey returns configured if non-empty; otherwise, in
// development, it generates and persists a random 32-byte key under
// DEV_KEY_DIR so it survives restarts. Production must have configured
// values (enforced by config.Validate before this is ever reached).
func loadOrGenerateKey(cfg *config.Config, filename string, configured []byte) ([]byte, error) {
	if len(configured) > 0 {
		return configured, nil
	}
	path := filepath.Join(cfg.DevKeyDir, filename)
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		return data, nil
	}
	if err := os.MkdirAll(cfg.DevKeyDir, 0o700); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// chainClient adapts the rpc provider pools to transaction.ChainClient.
type chainClient struct {
	registry *evm.Registry
	pools    map[int64]*rpc.Pool
}

func newChainClient(registry *evm.Registry, pools map[int64]*rpc.Pool) *chainClient {
	return &chainClient{registry: registry, pools: pools}
}

func (c *chainClient) poolForNetwork(networkID string) (*rpc.Pool, bool) {
	network, ok := c.registry.ByID(networkID)
	if !ok {
		return nil, false
	}
	pool, ok := c.pools[network.ChainID]
	return pool, ok
}
