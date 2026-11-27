# Deploying QD Wallet on Render

There are two ways to deploy:

- **[Free-tier beta, one service](#free-tier-beta-one-service)**: the web app and the API in one Docker service on a `*.onrender.com` address. This is the setup for the testnet beta, with no custom domain.
- **[API only](#service-settings)**: the Go backend as its own service, with the web app deployed separately on a sibling subdomain of a custom domain.

## Free-tier beta, one service

Browsers treat two `*.onrender.com` services as **different sites**, so the API's `SameSite=Strict` session cookies would not be sent from one to the other. The beta therefore serves the web app from the API's own origin. The image built by `deploy/render/Dockerfile` contains both, and `WEB_DIR` tells the API to serve the static export for every path it does not route. Each page keeps its build-generated, hash-based Content-Security-Policy. The API refuses to start if that header file is missing.

### Service

| Setting | Value |
|---|---|
| Type | Web Service, **Free** instance |
| Language | Docker |
| Root Directory | *(empty: the repository root)* |
| Dockerfile Path | `./deploy/render/Dockerfile` |
| Health Check Path | `/healthz` |

### Environment

Set everything in [Required](#required), with these differences:

| Variable | Value |
|---|---|
| `PORT` | `8080` |
| `ALLOWED_ORIGINS` | The service's own address, e.g. `https://qd-wallet-beta.onrender.com` |
| `ENABLE_SHARED_WALLETS` | `true` |
| `RELAYER_PRIVATE_KEY_<chainId>` | One per testnet, see [Shared wallets](#shared-wallets-testnet-beta) |
| `EVM_RPC_84532`, `EVM_RPC_421614`, `EVM_RPC_80002` | Keyed providers for Base Sepolia, Arbitrum Sepolia and Polygon Amoy |
| `HISTORY_PROVIDER_11155111` | `alchemy` |
| `BTC_NETWORK`, `BTC_ESPLORA_URL` | `testnet4` and an `https` Esplora API for Testnet4 (for example `https://mempool.space/testnet4/api`) |
| `HEDERA_MIRROR_URL` | Leave unset: the public Hedera **testnet** mirror is the default |
| `RPC_BACKGROUND_RPS` | `1`. Render may suspend free services that make unusually heavy outbound traffic |

`APP_ENV=production` and `WEB_DIR` are set by the image.

### Database: use a Postgres that does not expire

Render's free Postgres is **deleted 30 days after creation** (after a 14-day grace period) and has **no backups**. For a beta that people put shared wallets into, use a free managed Postgres without an expiry instead (for example Neon or Supabase; check their current free-tier terms), or a paid Render database. Requirements:

- PostgreSQL 16 or newer, with the `citext` extension available.
- Set `DATABASE_URL` to the provider's connection string with `sslmode=require`.

### Free-tier behaviour to expect

- **The service sleeps after 15 minutes without requests** and takes about a minute to wake up. While asleep, the relayer, the indexer and the gas monitor are paused. A shared-wallet execution that was approved continues when anyone opens the app again.
- **It can restart at any time**, losing local files. Nothing depends on them: keys come from secrets and state is in Postgres.
- **750 free instance hours a month** cover one service running all month.
- Rollbacks are limited to the two previous deploys.

## Service settings (API only)

| Setting | Value |
|---|---|
| Runtime | Go (native). The Docker option is in [Docker instead](#docker-instead) |
| Root Directory | `services/wallet-api` (the module is self-contained) |
| Build Command | `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/wallet-api ./cmd/wallet-api` |
| Start Command | `./bin/wallet-api` |
| Health Check Path | `/healthz` |
| Instances | **1** (see [One instance](#one-instance)) |

## Environment variables

### Required

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `STORE` | `postgres` |
| `DATABASE_URL` | Render's **internal** connection string for the database |
| `PORT` | `8080`. The server listens on `HTTP_ADDR` (default `:8080`) and does not read `PORT`. Setting `PORT=8080` tells Render which port to route to. The metrics server opens a second port, `:9090` |
| `JWT_SIGNING_KEY` | Secret: P-256 private key, see [Keys](#keys) |
| `CSRF_KEY` | Secret: `openssl rand -base64 32` |
| `IP_HASH_KEY` | Secret: `openssl rand -base64 32`, different from `CSRF_KEY` |
| `ALLOWED_ORIGINS` | The web app's exact origin, e.g. `https://app.example.com` |
| `EVM_RPC_11155111` | Secret: `alchemy=https://eth-sepolia.g.alchemy.com/v2/<key>`, optionally `,second=<url>` |
| `MIGRATE_ON_START` | `true` for the first deploy only (see [Migrations](#migrations)) |

### Optional

| Variable | Purpose |
|---|---|
| `KEY_ENCRYPTION_KEY` | Secret, `openssl rand -base64 32`. Not used by current features |
| `TRUSTED_PROXIES` | Needed for per-client rate limiting behind Render's proxy. Confirm the value from logs after the first deploy |
| `EVM_RPC_<chainId>` | One per additional chain, each with its own keyed provider |
| `HISTORY_PROVIDER_<chainId>` | History provider per chain |
| `RPC_BACKGROUND_RPS` | Rate of background indexing calls per second |
| `BTC_ESPLORA_URL`, `BTC_NETWORK` | Bitcoin. Production requires an `https` URL and the network `mainnet` or `testnet4` |
| `HEDERA_MIRROR_URL` | Hedera mirror node |
| `PRICE_PROVIDER`, `COINGECKO_API_KEY` | Live prices |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Tracing export |

### Shared wallets (testnet beta)

Shared-wallet execution runs only on public testnets. Production accepts a relayer key for Sepolia (`11155111`), Base Sepolia (`84532`), Arbitrum Sepolia (`421614`) and Polygon Amoy (`80002`). It refuses a key for any other chain, including every mainnet and local Anvil, and refuses relayer keys unless shared wallets are enabled.

| Variable | Value |
|---|---|
| `ENABLE_SHARED_WALLETS` | `true` |
| `RELAYER_PRIVATE_KEY_<chainId>` | Secret, one per testnet: a dedicated, testnet-only key. Fund it with test ETH only. Never reuse a key that has held mainnet funds |

The web build also needs `NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true`.

### Never set in production

The API refuses some of these at startup:

| Variable | Why |
|---|---|
| `RELAYER_PRIVATE_KEY_<mainnet id>` | Refused: shared-wallet execution is limited to public testnets while the on-chain Raccoon verifier is research-grade |
| `KEY_MANAGER=localdev` | Refused: keys must come from `JWT_SIGNING_KEY` |
| `COOKIE_SECURE=false` | Refused |
| `DEV_CREDENTIAL_RATE_BURST` | Refused: development-only setting |
| `STORE=memory`, `STORE_SNAPSHOT` | The in-memory store is refused in production |
| `EVM_RPC_31337` | Local Anvil only |

## Keys

With `APP_ENV=production` the API uses the **env key manager**:

- It loads keys only from the environment.
- It never generates or writes a key.
- Every instance and every restart uses the same key, so sessions survive redeploys.
- At startup it logs only a public fingerprint:

  ```
  "msg":"key manager: deployment keys loaded","kind":"env","signingKeyFingerprint":"<16 hex>","encryptionKeyConfigured":<bool>
  ```

  Record the fingerprint. It identifies the live key without revealing it.

### Generating `JWT_SIGNING_KEY`

Do this once, on a trusted machine:

```sh
openssl ecparam -name prime256v1 -genkey -noout | base64 -w0
```

Paste the single line into Render as a secret. A raw multi-line PEM, in SEC1 (`EC PRIVATE KEY`) or PKCS#8 (`PRIVATE KEY`) format, is also accepted. Only P-256 keys work, because tokens are signed with ES256.

Don't keep the key in the repository, in chat, or in shell history on shared machines. If it may have been exposed, rotate it.

### Rotating `JWT_SIGNING_KEY`

1. Generate a new key and replace the secret in Render. Then redeploy.
2. Access tokens signed with the old key stop verifying. They live for at most 10 minutes anyway. Clients get a 401 and refresh automatically. Refresh tokens are random values stored hashed in Postgres, not signed with this key, so nobody is logged out.
3. Check that the fingerprint in the startup log has changed.

`CSRF_KEY` and `IP_HASH_KEY` should stay stable. Changing `IP_HASH_KEY` makes stored IP hashes impossible to compare with new ones.

### Startup failures

Each fails fast with a one-line message. Messages name the variable, never its value:

| Message | Cause |
|---|---|
| `JWT_SIGNING_KEY is required when KEY_MANAGER=env` | The key is not set |
| `JWT_SIGNING_KEY: expected a PEM private key (or the PEM base64-encoded)` | The value is not a key |
| `JWT_SIGNING_KEY: key is on P-384; want P-256 (ES256)` | The key is on the wrong curve |
| `KEY_MANAGER=localdev is refused in production` | The development key manager was selected |

## Migrations

- The 8 embedded goose migrations run at startup **only** when `MIGRATE_ON_START=true`. They run before the API connects its pool, and nothing locks them against a second instance running them at the same time.
- They need the `citext` extension (`CREATE EXTENSION IF NOT EXISTS citext`). Confirm Render Postgres allows it before the first deploy.
- **First deploy:** use a fresh, empty database, one instance and `MIGRATE_ON_START=true`. Check the log for `goose: successfully migrated database to version: 13`, then set `MIGRATE_ON_START=false`.
- **Later deploys with new migrations:** set it to `true` for that one deploy.
- A database ever initialised by the GitHub shared-wallet build needs its migration history reconciled first; see `INTEGRATION.md`.

## One instance

There is no cross-instance locking for migrations, the chain indexer, the gas monitor or the shared-wallet relayer. Keep the service at one instance until that exists.

## Cookies and domains

Session cookies are `Secure` and `SameSite=Strict`. The web app and the API must therefore be on the **same site**, for example `app.example.com` and `api.example.com` under one custom domain. Two different `*.onrender.com` subdomains count as different sites, which would very likely break login.

## Docker instead

`services/wallet-api/Dockerfile` builds a distroless, non-root image with `APP_ENV=production` set. Use it to pin the Go version:

| Setting | Value |
|---|---|
| Root Directory | `services/wallet-api` |
| Dockerfile path | `./Dockerfile` |

The image has no shell.

## Verified before release

These checks were run against a local production configuration (`APP_ENV=production`, env key manager, Postgres store) on a throwaway database, never the Render one:

- Every migration applied from empty, up to version 13. A restart reported no migrations to run.
- `/healthz` returned 200. No dev key directory was created, and none of the secrets appeared in the logs.
- The browser full-stack test passed on desktop and mobile. It covers:
  - device login with tokens signed by the env key manager;
  - the authenticated RPC proxy;
  - address registration;
  - a tracked send stored in Postgres;
  - the security-event feed.
