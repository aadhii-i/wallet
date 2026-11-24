# 2026-11-20: Restoring shared wallets after the multichain integration

After `integration/multichain-shared-wallet` was merged, `/shared` said "Shared wallets are disabled". The Shared navigation link and the Gas Service section were missing, and every shared-wallet API route returned 404.

## Root cause

The integration put shared wallets behind two flags that are off unless set:

| Flag | Read by | Controls |
|---|---|---|
| `ENABLE_SHARED_WALLETS` | wallet-api, at start | Shared-wallet routes, relayer, gas monitor, `/v1/relayers` |
| `NEXT_PUBLIC_ENABLE_SHARED_WALLETS` | web app, at dev start / build | `/shared`, the Shared nav link, Gas Service in Settings |

Existing `.env` files never defined them. The Makefile's `export VAR` then exported an **empty** value, which counts as off, so `make api` and `make web` both started with the feature disabled. No code had been removed.

The audit against `653116d`, the last commit before the merge, found these other gaps:

1. **Shared wallets had been narrowed to Sepolia.** Before the merge they also worked on Base Sepolia, Arbitrum Sepolia, Polygon Amoy and local Anvil. The narrowing was in proposal creation, the relayer and the UI picker. The Makefile also no longer passed the local Anvil relayer key.
2. **Local setup was incomplete.** The Makefile never passed the rollup-testnet RPCs or the Bitcoin settings to the API. So Base Sepolia, Arbitrum Sepolia, Polygon Amoy and Bitcoin Testnet4 could not work under `make api`.
3. **The shared-wallet browser e2e had never passed after the merge** (the integration notes say it was skipped). It ran Anvil with Sepolia's chain ID, so Anvil applied Sepolia's hardfork (Amsterdam). There, one matrix-expansion transaction needs about 33M gas, more than Anvil's default 30M block. Real Sepolia's block gas limit is 200M, so it is not affected.

## Changes

**Configuration**

| File | Change |
|---|---|
| `Makefile` | The flags are exported only when `.env` sets them. Rollup testnet RPCs, relayer keys, history providers, Bitcoin and Hedera settings are passed to the API when set. The local Anvil relayer key is back in `make api`. `make web` no longer receives server-side RPC URLs or relayer keys. |
| `.env.example`, `apps/web/.env.example` | Explain that both flags must be `true` for local development. |
| `INTEGRATION.md` | The chain scope of shared wallets is corrected. |

**Backend**

| File | Change |
|---|---|
| `internal/sharedwallet/handlers.go` | One allow-list, `ExecutionChainAllowed`: Sepolia, Base Sepolia, Arbitrum Sepolia, Polygon Amoy and Anvil. Every other chain, including every mainnet, gets `400 UNSUPPORTED_CHAIN`. |
| `cmd/wallet-api/main.go` | Relayer keys and relayer chains use that allow-list. A key for any other chain is ignored, with a warning. |
| `internal/rpc/pool.go`, `proxy.go` | A request the *client* cancelled no longer counts against the provider's circuit breaker, and the proxy stops failing over once the client is gone. Before, browser navigations could mark a healthy upstream as failing for every user. |

**Frontend**

| File | Change |
|---|---|
| `features/shared/shared-wallets.tsx` | The proposal network picker offers the test networks again. Sepolia stays first (the default). Anvil appears only when local networks are enabled. |
| `packages/evm/src/discovery.ts` | Account discovery retries a failed lookup twice (after 0.4 s, then 1.2 s) before treating an index as unused. A rate-limited RPC no longer silently drops a used account on restore. |

**Tests**

- `sepolia_test.go`: every mainnet is rejected and every listed testnet is accepted.
- `client_cancel_test.go`: client cancellations do not open the breaker. Mutation-checked: it fails without the fix.
- `test/discovery.test.ts`: the retry behaviour.
- `playwright.shared.config.ts`: a Sepolia-sized block (`--gas-limit 60000000`) and Sepolia-like block production (`--block-time 1`) for the test chain.
- `e2e/shared-signing.spec.ts`:
  - accepts Sepolia's native symbol (`SepoliaETH`);
  - waits for the recharge transaction to be mined;
  - expects one gas-history row per execution.
- `e2e/wallet.spec.ts`:
  - uses the header's 6+6 address format;
  - waits for background Bitcoin-address sync before corrupting metadata;
  - derives the expected account from whatever discovery actually restored. This is the public Anvil phrase, used by many people on Sepolia.
- `e2e/multi-network.spec.ts`: expects the three always-listed non-EVM networks.
- `packages/rpc/test/shared-{wallets,keygen}.integration.test.ts`: two stale status expectations (`unavailable` and `awaiting_signing_session`) are corrected. The API built from `653116d` fails these tests identically, so they predate the integration.

## Local `.env` (never committed)

Lines appended; existing values unchanged:

```
ENABLE_SHARED_WALLETS=true
NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true
EVM_RPC_84532=public=https://sepolia.base.org
EVM_RPC_421614=public=https://sepolia-rollup.arbitrum.io/rpc
EVM_RPC_80002=public=https://polygon-amoy.drpc.org
BTC_ESPLORA_URL=https://mempool.space/testnet4/api
BTC_NETWORK=testnet4
```

`apps/web/.env.local` also gets `NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true`, for running `pnpm dev` directly.

## Verification

| Kind | Result |
|---|---|
| Go | `go vet` clean; every package passes |
| TypeScript | Workspace typecheck clean. Unit tests: qd-crypto 52, blockchain 23, wallet-core 113, qd-account 9 (+1 skipped), transaction 15, rpc 28 (+9 skipped: they need a live API), bitcoin 15, evm 35 (+2 skipped), web 195 (+2 skipped) |
| API integration (real wallet-api + Anvil) | Wallets/invitations/approvals 2/2. Key generation 2/2. Threshold signing + relayer execution 3/3. Gas service 1/1 (+1 live-chain test skipped) |
| Shared-wallet browser e2e (3 and 5 independent browsers, Anvil with Sepolia's chain ID and hardfork) | **2/2 pass** |
| Conventional wallet browser e2e (desktop + mobile) | **19/20 pass**, 4 skipped. The skips are 2 screenshot tests (`SCREENSHOTS=1`) on desktop and mobile. The failure: Sepolia Activity on desktop |
| Live dev servers | API routes registered (401, not 404). Networks 31337, 11155111, 84532, 421614 and 80002 served. Relayers ready on Sepolia and Anvil. Bitcoin Testnet4 enabled. Web dev server has the flag on and no server-side secrets in its environment |

**The shared-wallet browser e2e covers:**
- create, invite, join, member approval;
- 2-of-3 key setup with encrypted share delivery;
- account key registration;
- proposals and voting;
- 3-round threshold signing in two browsers' key workers;
- signature verification by the coordinator and on each device;
- one-time verifier setup;
- relayer execution, with the receipt checked against the chain;
- the PDF receipt;
- Wallet History (sent and received, same hash);
- the recipient's personal Activity;
- the over-budget block (nothing sent);
- the Gas Service balance, history and recharge.

**The conventional browser e2e covers:**
- creating a wallet, verifying the backup, receiving and sending ETH on Anvil;
- importing a phrase, discovering accounts, locking and unlocking;
- restoring a phrase, adding accounts, and keeping them across reloads;
- repairing tampered metadata;
- 15-word phrases and invalid-phrase rejection;
- the full stack through wallet-api: authentication, RPC proxy, address registration and a tracked send;
- strict security headers;
- every proxied network plus Bitcoin, Bitcoin Testnet4 and Hedera listed, with a live block read from each rollup testnet.

**Not verified end to end:**
- **A send of real Sepolia ETH.** No real funds were spent. The same code path is verified on Anvil, and earlier on Sepolia itself (tx `0x6f25f9b4…`).
- **Sepolia Activity.** It depends on live Alchemy data, and the free-tier quota rate-limits while two APIs and an indexer share it. It passed in some runs and failed in others.
- **Bitcoin and Hedera sends.** Only network visibility, the configuration and the unit tests were checked.

## Beta readiness

| Area | Status |
|---|---|
| Conventional EVM wallet (BIP-44, secp256k1, EIP-1559, Sepolia, explorer links) | Ready for a controlled beta |
| Shared wallets on Sepolia | **Experimental, testnet only.** The on-chain Raccoon verifier is research-grade. With `APP_ENV=production` the API refuses relayer keys, so execution needs a non-production deployment on testnets. Mainnets are rejected in code |
| Shared wallets on Base Sepolia, Arbitrum Sepolia, Polygon Amoy | Proposals and signing work. Execution needs `RELAYER_PRIVATE_KEY_<chainId>` for each chain |
| Bitcoin Testnet4, Hedera Testnet | Integrated and visible. Send flows are covered by unit tests only, not end to end in this pass |
| Bitcoin mainnet | Listed in the network picker, but the API serves only the network in `BTC_NETWORK` (testnet4 here), so mainnet calls fail. Hide it, or run a mainnet Esplora, before a beta |

## Operational notes

- **Restart after changing a flag.** Flags are read at start, so changing one requires restarting `make api` and `make web`.
- **Sepolia Gas Service balance.** It held 0.0499 SepoliaETH. At Sepolia's current fees (a 53-wei fee cap) one execution costs at most about 0.00000000076 SepoliaETH, so this covers millions of executions; at a 1-gwei fee cap it would cover about three. Settings → Gas Service shows the live figure. (Corrected: this note first said "roughly three executions", which assumed gwei-level fees.)
- **Postgres databases.** A database created by the GitHub shared-wallet version needs a migration-history reconciliation; see `INTEGRATION.md`.
