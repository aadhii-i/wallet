# wallet-api

Go backend for QD Wallet, a **non-custodial** multi-chain crypto wallet. This
service never receives, stores, or logs mnemonics, seeds, private keys,
vault passwords, PINs, or client key shares. It never builds the transaction
payload a client signs. It holds no chain keys. See
`docs/architecture/qd-wallet-v1-technical-spec.md` §9, §20-§26 and
`docs/api/openapi.yaml` for the authoritative contract.

## Running in development

Everything below works with `STORE=memory` and no Postgres/Redis. Optionally
point it at a local Anvil node for the RPC proxy / history / tx tracking.

```bash
# from services/wallet-api
go mod download

# start Anvil separately if you want live chain data:
#   anvil --chain-id 31337

APP_ENV=development \
STORE=memory \
HTTP_ADDR=:8080 \
METRICS_ADDR=:9090 \
ALLOWED_ORIGINS=http://localhost:3000 \
COOKIE_SECURE=false \
EVM_RPC_31337=anvil=http://127.0.0.1:8545 \
  go run ./cmd/wallet-api
```

With `COOKIE_SECURE=false`, cookies are named `qd_at`/`qd_rt` (no `__Host-`
prefix, no `Secure` flag) so they work over plain HTTP in local dev only.
CSRF/IP-hash HMAC keys are auto-generated into `DEV_KEY_DIR`
(`./.dev-keys` by default) on first run when unset, and reused across
restarts. **Never do this in production** — `APP_ENV=production` requires
`CSRF_KEY`/`IP_HASH_KEY` to be set and refuses the localdev `KeyManager` and
`STORE=memory`.

Health/readiness: `GET :8080/healthz`, `GET :8080/readyz`.
Prometheus metrics: `GET :9090/metrics`.

## Running tests

```bash
cd services/wallet-api
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go test ./...
gofmt -l .   # should print nothing
```

`CGO_ENABLED=0` is required in this environment: `go-ethereum`'s cgo
secp256k1 backend fails to build with the available 32-bit-only MinGW gcc
(`cc1.exe: sorry, unimplemented: 64-bit mode not compiled in`). With cgo
disabled, `go-ethereum/crypto` falls back to its pure-Go backend, which is
what the Dockerfile also uses (`CGO_ENABLED=0`), so this is not a
dev/prod mismatch.

Postgres-backed store tests are skipped unless `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL="postgres://user:pass@localhost:5432/wallet_test?sslmode=disable" \
  CGO_ENABLED=0 go test ./internal/store/postgres/... -v
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `APP_ENV` | `development` | `development` \| `production`. Production enforces the invariants below. |
| `HTTP_ADDR` | `:8080` | Main API port (also serves `/healthz`, `/readyz`). |
| `METRICS_ADDR` | `:9090` | Separate port serving `/metrics`. |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated. Used for CORS and for validating the `Origin` header on cookie-bearing auth/refresh requests. |
| `STORE` | `memory` | `memory` \| `postgres`. `memory` is refused when `APP_ENV=production`. |
| `DATABASE_URL` | — | Required when `STORE=postgres`. |
| `MIGRATE_ON_START` | `false` | Runs embedded goose migrations against `DATABASE_URL` at boot. |
| `REDIS_URL` | — | Optional. Not currently used (see Deviations) — rate limiting is in-process. |
| `COOKIE_SECURE` | `true` | `false` only for local HTTP dev; switches cookie names from `__Host-qd_at`/`__Host-qd_rt` to `qd_at`/`qd_rt` and drops `Secure`. Refused `false` in production. |
| `DEV_KEY_DIR` | `./.dev-keys` | Where the localdev `KeyManager` and auto-generated CSRF/IP-hash keys are stored. Refused in production. |
| `CSRF_KEY` | — | HMAC key for CSRF tokens. Required in production; auto-generated into `DEV_KEY_DIR` in development if unset. |
| `IP_HASH_KEY` | — | HMAC key for hashing IPs before storage. Same rules as `CSRF_KEY`. |
| `EVM_RPC_<chainId>` | — | Comma-separated upstream URLs in priority order, each optionally `name=url` (e.g. `EVM_RPC_11155111=alchemy=https://...,infura=https://...`). A chain is only enabled/listed in `/v1/networks` if it has at least one upstream. |
| `ENABLE_LOCAL_NETWORKS` | `true` | Documented per spec; in the current implementation, Anvil (31337) is simply enabled by configuring `EVM_RPC_31337` like any other chain — see Deviations. |
| `HISTORY_PROVIDER_<chainId>` | `scanner` for 31337, `none` otherwise | `scanner` \| `alchemy` \| `none`. |
| `PRICE_PROVIDER` | `static` | `static` \| `coingecko`. |
| `COINGECKO_API_KEY` | — | Optional, used only when `PRICE_PROVIDER=coingecko`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | If set, intended to enable OTLP tracing (see Deviations — not wired up in this pass). |

### `.env.example`

```env
APP_ENV=development
HTTP_ADDR=:8080
METRICS_ADDR=:9090
ALLOWED_ORIGINS=http://localhost:3000
STORE=memory
DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet?sslmode=disable
MIGRATE_ON_START=false
REDIS_URL=
COOKIE_SECURE=false
DEV_KEY_DIR=./.dev-keys
CSRF_KEY=
IP_HASH_KEY=
EVM_RPC_31337=anvil=http://127.0.0.1:8545
ENABLE_LOCAL_NETWORKS=true
HISTORY_PROVIDER_31337=scanner
PRICE_PROVIDER=static
COINGECKO_API_KEY=
```

## Architecture notes

- **Layout** follows the spec: `internal/platform/{config,db,logging,httpx,metrics}`,
  `internal/auth`, `internal/security`, `internal/account`, `internal/transaction`,
  `internal/blockchain/evm`, `internal/rpc`, `internal/prices`, `internal/audit`,
  `internal/store` (+ `memory`, `postgres`), `migrations/` (goose, embedded).
- **Auth** (`internal/auth`): P-256 device-key challenge/response, IEEE
  P1363 signature verification, ES256 JWT access tokens (10 min) signed via
  the `security.KeyManager` abstraction, refresh tokens stored only as
  SHA-256 hashes with per-rotation generations for reuse detection (see
  `store.RefreshToken`: a session's id is stable across refreshes; each
  refresh creates a new hash generation and marks the previous one
  `Rotated`, so replaying an old token is detected and the whole session is
  revoked plus a `refresh_token_reuse` critical security event is recorded).
- **CSRF**: `POST /v1/auth/challenge|register|login|refresh` do **not**
  require `X-CSRF-Token` — they either precede having a session, or (for
  `refresh`) exist specifically so a web client can recover its in-memory
  CSRF token after a reload. Cookie-bearing requests to these routes are
  instead held to the `ALLOWED_ORIGINS` allow-list plus `SameSite=Strict`
  cookies. Every other unsafe, cookie-authenticated route (logout, wallet/
  account writes, the RPC proxy, etc.) requires a matching `X-CSRF-Token`.
- **RPC proxy** (`internal/rpc`): method allowlist, batch cap (20),
  `eth_getLogs` range cap (2000 blocks, explicit hex bounds only), a
  provider pool per chain with per-provider circuit breakers (opens after 5
  consecutive failures, half-opens after 30s) and a periodic
  `eth_blockNumber` health probe (demotes providers >3 blocks behind the
  best head), method-specific timeouts, failover/retry for read methods
  only, and careful `eth_sendRawTransaction` handling (checks
  `eth_getTransactionByHash` on other providers before ever resending the
  identical raw bytes — never re-signs, never resends a different payload).
- **Redaction** (`internal/platform/logging`): a `slog.Handler` wrapper that
  drops any attribute (including nested groups) whose key matches
  `mnemonic|seed|phrase|private|secret|password|pin|share|token|authorization|cookie`
  case-insensitively, and masks any run of ≥12 space-separated lowercase
  words that are all valid BIP-39 English words (the wordlist is embedded
  from `bip39_english.txt`, verified at `init()` to have exactly 2048
  entries).
- **Audit log** (`internal/audit`): pure hash-chain functions
  (`RowHash`, `VerifyChain`) shared by both store backends, so
  `row_hash = SHA-256(prev_hash || canonical_json(row))` is computed
  identically everywhere and tamper detection is tested once.
- **Address ownership proof** (`internal/account`): EIP-191 `personal_sign`
  verification via `go-ethereum/crypto` (`ecrecover`), message format
  `QDWallet-Address|v1|{accountId}|{address-lowercase}|{userId}`.
- **Activity/poisoning** (`internal/blockchain/evm`): merges tracked
  transactions with a `HistoryProvider` (scanner for Anvil/dev, Alchemy via
  `alchemy_getAssetTransfers`, or none); flags `suspected_poisoning` on
  zero-value incoming transfers and on incoming transfers from addresses
  whose first-4/last-4 hex characters match a previously-sent-to address.

## Deviations from the spec (be honest about what's simplified)

- **No `oapi-codegen` / no `sqlc`.** Neither binary is available in this
  offline-ish environment. Request/response types are hand-written Go
  structs kept in sync with `docs/api/openapi.yaml` by hand, and every
  Postgres query in `internal/store/postgres` is hand-written `pgx` SQL
  rather than generated. This is the single biggest place where the
  implementation and the OpenAPI contract could drift silently; a
  Schemathesis-style contract test (spec §27.1) is **not** included.
- **No Redis, no asynq.** `REDIS_URL` is accepted but unused. Rate limiting
  is an in-process token bucket (`internal/security.KeyedTokenBucket`),
  which is correct for a single replica but does not coordinate across
  multiple `wallet-api` instances. The background transaction tracker is an
  in-process goroutine (`internal/transaction.Tracker.Run`) rather than an
  asynq job on Redis; it polls every 3s with a simple per-tx backoff up to
  30s, matching the spec's timing but not its worker architecture. There is
  no `history.sync` or `prices.refresh` background worker — history is
  fetched on-demand (with a short in-memory cache in the scanner), and
  prices are cached for 60s on request rather than refreshed on a timer.
- **No Postgres `RLS`.** The spec calls for `SET app.user_id` + Postgres
  row-level security as defence-in-depth on top of the `user_id` predicate
  in every query. Every postgres repository method here does include the
  `user_id` predicate (checked by the IDOR-style tests), but RLS policies
  and the `SET app.user_id` plumbing are not implemented in the migration.
- **Challenges live in whichever store is configured** (memory or
  Postgres), not dedicated Redis with TTL expiry; expiry is checked at read
  time instead of relying on key eviction. Functionally equivalent for a
  60s TTL at this scale.
- **No OpenTelemetry wiring.** `OTEL_EXPORTER_OTLP_ENDPOINT` is read into
  config but no tracer/exporter is constructed — there was no OTel
  collector available to validate against in this environment, and I did
  not want to ship untested tracing code. `otelhttp` middleware is not
  mounted.
- **`ENABLE_LOCAL_NETWORKS`** is parsed but not actually gating anything:
  Anvil (31337) is enabled purely by whether `EVM_RPC_31337` has an
  upstream configured, same as every other chain. The flag is a no-op today
  rather than a hard override.
- **Monero, MPC/QD signer, policy engine, recovery workflows** are all
  explicitly out of scope per the spec (D1/D2/M5-M7) and are not present
  here at all — no `internal/blockchain/monero`, no `internal/signer`, no
  `internal/policy`, no `internal/recovery`.
- **`GET /v1/assets`** (curated token list) from spec §19.1 is not
  implemented; it wasn't in `docs/api/openapi.yaml`'s path list, so it was
  treated as out of scope for this pass.
- **`/v1/devices/link`, `/v1/security/events/{id}/ack`, `/v1/events/stream`
  (SSE), `/v1/rpc/monero/*`** are listed in the technical spec's §19.1 table
  but are not in `openapi.yaml`; per the instructions to follow
  `openapi.yaml` exactly, they are not implemented.
- **KeyManager** ships only the `localdev` (file-backed PEM + AES-GCM)
  implementation described in spec §13.3. `awskms`/`gcpkms`/`vault` are not
  implemented (no cloud credentials available in this environment).
- **Attestation** (App Attest / Play Integrity) fields from spec §22 are
  not collected or stored; `register` accepts `platform` and `label` only,
  per `openapi.yaml`'s `register` request body.
- **Idempotency** replay only re-sends the cached response body/status; it
  does not attempt to detect a *different* body reusing the same key (which
  the spec doesn't fully define either).
- **RPC per-IP limit** applies only to the unauthenticated auth routes
  (`challenge`/`register`/`login`/`refresh`); the RPC proxy itself is
  always authenticated, so it only has the per-session limiter.

## Known open issues

- The EVM history scanner (`internal/blockchain/evm.ScannerProvider`) scans
  blocks one RPC call at a time up to 5000 blocks; against a real RPC
  provider (not Anvil) this would be slow and should be replaced with
  batched calls or a real indexer before it is used against a busy mainnet
  chain. It is intended for local dev only, matching the spec's
  "scanner (Anvil): dev/test" framing.
- `internal/store/postgres` compiles and has IDOR/audit-chain integration
  tests gated on `TEST_DATABASE_URL`, but those tests have not actually
  been run against a live Postgres in this environment (no Docker daemon
  available here) — only `go build`/`go vet` and the skip-path have been
  verified.
- The Dockerfile has not been built or run (`docker` daemon is not running
  in this environment per the task setup); it has been reviewed by hand
  only (multi-stage, `CGO_ENABLED=0`, distroless nonroot, no shell).
