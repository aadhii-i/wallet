// Command wallet-api is the QD Wallet backend: a non-custodial, modular
// monolith serving auth, wallet/account/address management, an EVM RPC
// proxy, transaction tracking, prices, and security events. See
// docs/api/openapi.yaml and docs/architecture/qd-wallet-v1-technical-spec.md.
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/qdwallet/wallet-api/internal/account"
	"github.com/qdwallet/wallet-api/internal/auth"
	"github.com/qdwallet/wallet-api/internal/bitcoinshared"
	"github.com/qdwallet/wallet-api/internal/blockchain/btc"
	"github.com/qdwallet/wallet-api/internal/blockchain/evm"
	"github.com/qdwallet/wallet-api/internal/blockchain/hedera"
	"github.com/qdwallet/wallet-api/internal/hederashared"
	"github.com/qdwallet/wallet-api/internal/indexer"
	"github.com/qdwallet/wallet-api/internal/nativecustody"
	"github.com/qdwallet/wallet-api/internal/platform/config"
	"github.com/qdwallet/wallet-api/internal/platform/db"
	"github.com/qdwallet/wallet-api/internal/platform/httpx"
	"github.com/qdwallet/wallet-api/internal/platform/logging"
	"github.com/qdwallet/wallet-api/internal/platform/metrics"
	"github.com/qdwallet/wallet-api/internal/prices"
	"github.com/qdwallet/wallet-api/internal/rpc"
	"github.com/qdwallet/wallet-api/internal/security"
	"github.com/qdwallet/wallet-api/internal/sharedwallet"
	"github.com/qdwallet/wallet-api/internal/store"
	"github.com/qdwallet/wallet-api/internal/store/memory"
	"github.com/qdwallet/wallet-api/internal/store/postgres"
	"github.com/qdwallet/wallet-api/internal/transaction"
	"github.com/qdwallet/wallet-api/internal/webstatic"
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
	var km security.KeyManager
	switch cfg.KeyManager {
	case config.KeyManagerEnv:
		envKM, err := security.NewEnvKeyManager(security.EnvKeys{SigningKey: cfg.JWTSigningKey, EncryptionKey: cfg.KeyEncryptionKey})
		if err != nil {
			return fmt.Errorf("key manager: %w", err)
		}
		// Public fingerprint only: confirms which key this instance runs with.
		logger.Info("key manager: deployment keys loaded", "kind", "env",
			"signingKeyFingerprint", envKM.Fingerprint(), "encryptionKeyConfigured", envKM.HasEncryptionKey())
		km = envKM
	default:
		devKM, err := security.NewLocalDevKeyManager(cfg.DevKeyDir, isProduction)
		if err != nil {
			return fmt.Errorf("key manager: %w", err)
		}
		km = devKM
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
	var memStore *memory.Store
	switch cfg.Store {
	case config.StoreMemory:
		memStore = memory.New()
		st = memStore
		logger.Info("using in-memory store (not for production)")
		if cfg.StoreSnapshot != "" {
			loaded, err := memStore.Load(cfg.StoreSnapshot)
			if err != nil {
				return fmt.Errorf("STORE_SNAPSHOT: %w", err)
			}
			logger.Info("in-memory store persisted to a snapshot file", "path", cfg.StoreSnapshot, "restored", loaded)
		} else {
			logger.Warn("in-memory store without STORE_SNAPSHOT: a restart loses all wallets, proposals and executions")
		}
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
	bitcoinSnapshot := ""
	if cfg.StoreSnapshot != "" {
		bitcoinSnapshot = cfg.StoreSnapshot + ".bitcoin-shared"
	}
	bitcoinRelay, err := bitcoinshared.New(st, pgPool, bitcoinSnapshot)
	if err != nil {
		return err
	}

	hederaSnapshot := ""
	if cfg.StoreSnapshot != "" {
		hederaSnapshot = cfg.StoreSnapshot + ".hedera-shared"
	}
	hederaRelay, err := hederashared.New(st, pgPool, hederaSnapshot)
	if err != nil {
		return err
	}

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
		if chainID != 31337 {
			// Background work (chain indexing) must leave the provider
			// quota to users and the relayer.
			pools[chainID].SetBackgroundRate(float64(cfg.RPCBackgroundRPS))
		}
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

	// --- Bitcoin (Esplora REST API) -----------------------------------------
	// Bitcoin is off unless BTC_ESPLORA_URL is set. The server never holds
	// spending keys: it only sees public addresses and signed transactions.
	var btcSvc *btc.Service
	if cfg.BTCEnabled() {
		esplora := btc.NewEsplora(btc.EsploraConfig{
			BaseURL: cfg.BTCEsploraURL,
		})
		btcSvc = btc.NewService(esplora, btc.Network(cfg.BTCNetwork), cfg.BTCFeeFloorSatVB, cfg.BTCMaxFeeSatVB, logger)
		logger.Info("bitcoin support enabled",
			slog.String("network", cfg.BTCNetwork),
			slog.String("esplora", cfg.BTCEsploraURL),
		)
	}
	btcHandlers := btc.NewHandlers(btcSvc)

	// --- Hedera (Mirror Node REST API) -------------------------------------
	// Hedera always wires up with the default public testnet Mirror Node unless
	// HEDERA_MIRROR_URL overrides it.
	hederaMirror := hedera.NewMirror(hedera.MirrorConfig{BaseURL: cfg.HederaMirrorURL})
	hederaSvc := hedera.NewService(hederaMirror)
	hederaHandlers := hedera.NewHandlers(hederaSvc)
	// The migration coordinator has read-only chain access. Only participant
	// browsers can authorize, sign and submit the reviewed native operations.
	migrationSnapshot := ""
	if cfg.StoreSnapshot != "" {
		migrationSnapshot = cfg.StoreSnapshot + ".native-migrations"
	}
	migrationRepo, err := nativecustody.NewMigrationRepository(pgPool, migrationSnapshot)
	if err != nil {
		return err
	}
	var bitcoinReader nativecustody.BitcoinReader
	if btcSvc != nil {
		bitcoinReader = btcSvc
	}
	nativeMigrations := nativecustody.NewCoordinator(st, migrationRepo, bitcoinRelay, hederaRelay, bitcoinReader, hederaSvc)
	bitcoinRelay.SetMigrationGuard(nativeMigrations.Guard("bitcoin"))
	hederaRelay.SetMigrationGuard(nativeMigrations.Guard("hedera"))

	// --- HTTP handlers -----------------------------------------------------------
	cookies := auth.CookieNames{Access: cfg.AccessCookieName(), Refresh: cfg.RefreshCookieName()}
	authHandlers := auth.NewHandlers(authSvc, cfg.AllowedOrigins, cfg.CookieSecure, cookies, csrfKey, ipHashKey, cfg.TrustedProxies)
	acctHandlers := account.NewHandlers(acctSvc, st, hederaSvc)
	sharedHandlers := sharedwallet.NewHandlers(sharedwallet.NewService(st))

	// --- Shared-wallet relayer: submits verified Raccoon signatures to QdAccount.
	// Relayer keys are used only when shared wallets are enabled, and only for
	// test networks: a key configured for any other chain is ignored.
	sharedKeys := make(map[int64]string)
	for chainID, key := range cfg.RelayerKeys {
		if cfg.EnableSharedWallets && key != "" && sharedwallet.ExecutionChainAllowed(chainID) {
			sharedKeys[chainID] = key
		} else if key != "" {
			logger.Warn("shared-wallet relayer key ignored", "chain", chainID, "sharedWalletsEnabled", cfg.EnableSharedWallets)
		}
	}
	relayerKeys, err := sharedwallet.ParseRelayerKeys(sharedKeys)
	if err != nil {
		return err
	}
	relayer := sharedwallet.NewRelayer(st, func(chainID int64) (sharedwallet.ChainCaller, bool) {
		if !sharedwallet.ExecutionChainAllowed(chainID) {
			return nil, false
		}
		p, ok := pools[chainID]
		return p, ok
	}, relayerKeys, logger)
	for chainID := range pools {
		if sharedwallet.ExecutionChainAllowed(chainID) {
			relayer.ChainIDs = append(relayer.ChainIDs, chainID)
		}
	}
	slices.Sort(relayer.ChainIDs)
	for chainID := range relayerKeys {
		addr, _ := relayer.RelayerAddress(chainID)
		logger.Warn("shared-wallet relayer enabled (development)", "chain", chainID, "relayer", addr.Hex())
	}
	for _, chainID := range relayer.ChainIDs {
		if _, ok := relayerKeys[chainID]; !ok && chainID != 1 {
			logger.Info("shared-wallet execution disabled for chain: no relayer key", "chain", chainID, "env", fmt.Sprintf("RELAYER_PRIVATE_KEY_%d", chainID))
		}
	}
	// Startup diagnostics: RPC chain id, relayer balance and contract status per chain (no secrets).
	go func() {
		ctx, cancel := context.WithTimeout(healthCtx, 20*time.Second)
		defer cancel()
		for _, cs := range relayer.Status(ctx) {
			if !cs.RelayerConfigured {
				continue
			}
			logger.Info("shared-wallet relayer status", "chain", cs.ChainID, "relayer", cs.RelayerAddress, "rpcOk", cs.RPCOK,
				"balanceWei", cs.RelayerBalanceWei, "verifierDeployed", boolp(cs.VerifierDeployed), "factoryDeployed", boolp(cs.FactoryDeployed),
				"ready", cs.Ready, "problems", strings.Join(cs.Problems, "; "))
		}
	}()
	for chainID, v := range cfg.GasLowBalanceWei {
		n, ok := new(big.Int).SetString(strings.TrimSpace(v), 10)
		if !ok || n.Sign() < 0 {
			return fmt.Errorf("GAS_LOW_BALANCE_WEI_%d must be a non-negative decimal amount of wei", chainID)
		}
		relayer.LowBalanceWei[chainID] = n
	}
	sharedHandlers.SetRelayer(relayer)
	if cfg.EnableSharedWallets {
		go relayer.Run(healthCtx)
		// The gas monitor watches one address with a small call budget: it stays
		// in the normal lane so Gas Service history is not queued behind indexing.
		go sharedwallet.NewGasMonitor(relayer).Run(healthCtx)
	}
	relayerStatus := newRelayerStatusHandler(relayer)
	snapshotDone := make(chan struct{})
	if memStore != nil && cfg.StoreSnapshot != "" {
		go func() {
			defer close(snapshotDone)
			memStore.RunSnapshots(healthCtx, cfg.StoreSnapshot, 2*time.Second, logger)
		}()
	} else {
		close(snapshotDone)
	}
	txHandlers := transaction.NewHandlers(txSvc, st)
	activityHandlers := transaction.NewActivityHandlers(st, providerRegistry(historyByNetwork))
	// Chain index: persistent personal Activity and shared Wallet History from receipts (read-only).
	chainIndex := indexer.New(st, func(chainID int64) (indexer.Caller, bool) {
		p, ok := pools[chainID]
		if !ok {
			return nil, false
		}
		return rpc.BackgroundCaller(p), true
	}, logger)
	for chainID := range pools {
		chainIndex.ChainIDs = append(chainIndex.ChainIDs, chainID)
	}
	go chainIndex.Run(healthCtx)
	activityHandlers.SetIndex(chainIndex, func(networkID string) (int64, bool) {
		n, ok := registry.ByID(networkID)
		if !ok {
			return 0, false
		}
		return n.ChainID, true
	})
	sharedHandlers.SetIndex(chainIndex, func(chainID int64) (*sharedwallet.HistoryNetwork, bool) {
		n, ok := registry.ByChainID(chainID)
		if !ok || !n.Enabled {
			return nil, false
		}
		return &sharedwallet.HistoryNetwork{Name: n.Name, ExplorerTxURL: n.ExplorerTxURL}, true
	}, indexer.Sanitize)
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
	if cfg.DevCredentialBurst > 0 && cfg.AppEnv != config.EnvProduction {
		// Development only (Validate refuses it in production): lets local
		// multi-user tests register many independent devices from one IP.
		credentialRateLimit = security.NewKeyedTokenBucket(float64(cfg.DevCredentialBurst)/60.0, cfg.DevCredentialBurst)
		unauthRateLimit = security.NewKeyedTokenBucket(float64(cfg.DevCredentialBurst), cfg.DevCredentialBurst)
		logger.Warn("development credential rate limit override active", "burst", cfg.DevCredentialBurst)
	}

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
	// Relayer diagnostics: chain id, RPC reachability, relayer address and
	// balance, contract deployment. Public data only; never key material.
	if cfg.EnableSharedWallets {
		r.Get("/v1/relayers", relayerStatus)
	}
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

		// Shared wallets: participants, proposals and signed approvals.
		if cfg.EnableSharedWallets {
			sharedHandlers.Routes(r)
			bitcoinRelay.Routes(r)
			hederaRelay.Routes(r)
			nativeMigrations.Routes(r)
		}

		r.Group(func(r chi.Router) {
			r.Use(auth.RateLimitBySession(sessionRateLimit))
			r.Post("/v1/rpc/evm/{chainId}", rpcHandler.ServeHTTP)

			// Bitcoin: purpose-built endpoints only, no RPC passthrough.
			r.Get("/v1/btc/{network}/fees", btcHandlers.GetFees)
			r.Get("/v1/btc/{network}/identity", btcHandlers.GetIdentity)
			r.Get("/v1/btc/{network}/address/{address}/utxos", btcHandlers.GetUTXOs)
			r.Get("/v1/btc/{network}/address/{address}/used", btcHandlers.GetAddressUsed)
			r.Get("/v1/btc/{network}/address/{address}/history", btcHandlers.GetHistory)
			r.Get("/v1/btc/{network}/tx/{hash}", btcHandlers.GetTransaction)
			r.Get("/v1/btc/{network}/tx/{hash}/raw", btcHandlers.GetRawTransaction)
			r.Post("/v1/btc/{network}/broadcast", btcHandlers.Broadcast)

			// Hedera: Mirror Node balance lookup.
			r.Get("/v1/hedera/{network}/account/{accountId}/balance", hederaHandlers.GetBalance)
			r.Get("/v1/hedera/{network}/account/{accountId}/info", hederaHandlers.GetInfo)
			r.Get("/v1/hedera/{network}/transaction/{transactionId}", hederaHandlers.GetTransaction)
			// Hedera: Mirror Node transaction history.
			r.Get("/v1/hedera/{network}/account/{accountId}/history", hederaHandlers.GetHistory)
		})
	})

	// Optionally serve the web app from this origin too (WEB_DIR): every path
	// the API does not route gets the static export, with its per-page CSP.
	if cfg.WebDir != "" {
		web, err := webstatic.New(cfg.WebDir, webstatic.Options{PlainHTTP: !isProduction})
		if err != nil {
			return err
		}
		defer web.Close()
		r.NotFound(web.ServeHTTP)
		logger.Info("serving the web app", slog.String("dir", cfg.WebDir))
	}

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
	<-snapshotDone // final snapshot after the servers stopped accepting requests

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

func boolp(b *bool) string {
	if b == nil {
		return "unknown"
	}
	return strconv.FormatBool(*b)
}

// newRelayerStatusHandler serves relayer diagnostics, cached for 10 s so the
// public endpoint cannot be used to hammer upstream RPC providers.
func newRelayerStatusHandler(rel *sharedwallet.Relayer) http.HandlerFunc {
	var mu sync.Mutex
	var cached []byte
	var at time.Time
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		// ?refresh=1 (the UI's "Refresh balance") bypasses the cache, at most every 3 s.
		maxAge := 10 * time.Second
		if r.URL.Query().Get("refresh") == "1" {
			maxAge = 3 * time.Second
		}
		if cached == nil || time.Since(at) > maxAge {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			b, err := json.Marshal(map[string]any{"chains": rel.Status(ctx)})
			cancel()
			if err != nil {
				http.Error(w, "status unavailable", http.StatusInternalServerError)
				return
			}
			cached, at = b, time.Now()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(cached)
	}
}
