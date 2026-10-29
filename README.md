# QD Wallet

A non-custodial, multi-chain wallet (Ethereum / EVM now, Monero and QD/MPC signing later) with a web client, a Go backend and shared TypeScript wallet libraries.

- **Specification:** [docs/architecture/qd-wallet-v1-technical-spec.md](docs/architecture/qd-wallet-v1-technical-spec.md)
- **Decisions:** [docs/adr/](docs/adr/README.md)
- **API contract:** [docs/api/openapi.yaml](docs/api/openapi.yaml)
- **Chain registry contract:** [docs/api/networks.json](docs/api/networks.json) ([ADR 0015](docs/adr/0015-one-network-table-asserted-from-both-sides.md))
- **Enable another chain:** [docs/operations/enable-an-evm-chain.md](docs/operations/enable-an-evm-chain.md)

> Status: **V1 preview — testnet/local use only.** Not audited. Do not use with real funds.

## What works today

| Milestone | Status |
|---|---|
| M0 Spec, ADRs, API contract, schema | ✅ |
| M1 Wallet core (BIP-39, BIP-32/44, encrypted vault, HD signer) | ✅ tested against official vectors and viem |
| M2 Ethereum: balances, fees, send, receive, history, tracking | ✅ verified end-to-end on Anvil; 🚧 Ethereum Sepolia connected (see [below](#ethereum-sepolia-testnet)) |
| M2+ Multi-chain EVM: Base, Arbitrum One, Polygon PoS and their testnets | ✅ Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and Polygon Amoy are selectable and read live blocks through the RPC proxy. 🚧 The four mainnets are declared but gated, and no fee strategy has quoted a live rollup yet ([runbook](docs/operations/enable-an-evm-chain.md)) |
| M3 Web wallet (Next.js) | ✅ onboarding, backup, import, unlock, accounts, networks, send/receive, activity, security, settings |
| M4 Mobile (Expo) | ⏳ not started |
| M5 Monero | ⏳ blocked on ADR 0006/0007 spike |
| M6 Security architecture (KMS, policies, recovery) | ⏳ partial (KeyManager interface, audit log, security events) |
| M7 QD/MPC signing | 🚧 D1 resolved ([analysis](docs/qd-protocol/README.md), [ADR 0014](docs/adr/0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md)); `packages/qd-crypto` protocol done; co-signer and on-chain verifier next |
| M8 Production infra | ⏳ CI + compose only |

## Layout

```
apps/web                 Next.js static wallet UI (KeyWorker holds keys)
services/wallet-api      Go modular monolith: auth, RPC proxy, history, tracking, audit
packages/wallet-core     Mnemonic, vault, derivation, Signer/HDSigner, confirmation tokens
packages/blockchain      Chain-agnostic adapter interface, networks, assets, amount maths
packages/evm             EVM adapter (viem)
packages/transaction     Send state machine, risk checks, error mapping
packages/rpc             Typed API client + device-key auth + proxy transport
packages/shared-types    Wire types (mirror openapi.yaml)
packages/ui              Design and motion tokens
packages/qd-crypto       QD-Wallet: post-quantum threshold (Threshold Raccoon) signing, stateless derivation
```

## Quick start (no Docker)

Requirements: Node 22+, Go 1.26+, [Foundry](https://getfoundry.sh) (`anvil`).

```bash
corepack enable && pnpm install          # or: corepack pnpm@9.15.0 install
make anvil                               # terminal 1 — local chain (chain id 31337)
make api                                 # terminal 2 — wallet-api, in-memory store
cp apps/web/.env.example apps/web/.env.local
make web                                 # terminal 3 — http://localhost:3000
```

Import the Anvil test phrase `test test test test test test test test test test test junk` to get funded accounts, or create a wallet and run `make fund ADDRESS=0x…`.

With Docker: `cp .env.example .env && make up` starts Postgres, Redis, Anvil, wallet-api, the OTel collector, Prometheus and Grafana.

## Ethereum Sepolia testnet

The wallet can run against the public Sepolia testnet (chain id `11155111`) via an Alchemy endpoint. The browser never sees the provider URL: it talks to wallet-api's authenticated RPC proxy, which reads the upstream from the server-side environment.

```bash
cp .env.example .env    # gitignored; never commit it
# then set your own key in .env:
# EVM_RPC_11155111=alchemy=https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_API_KEY>
make api                # terminal 1 — picks up EVM_RPC_11155111 from .env
make web                # terminal 2 — http://localhost:3000
```

In the app, choose **Ethereum Sepolia** in the network selector. Under the balance you should see `Ethereum Sepolia · #<latest block>`, which updates every ~15 s. To get test ETH, open **Receive**, copy the address and use the [Alchemy Sepolia faucet](https://www.alchemy.com/faucets/ethereum-sepolia). Transactions link to [sepolia.etherscan.io](https://sepolia.etherscan.io/).

**Signing:** Ethereum transactions are signed with the conventional BIP-32/44 secp256k1 ECDSA signer (`HDSigner`, MetaMask-compatible path `m/44'/60'/0'/0/n`) inside the KeyWorker. The QD threshold signer in `packages/qd-crypto` is **not** used for Ethereum transactions. A Threshold Raccoon signature is not a valid signature for an ordinary Ethereum account; using it needs a smart-contract account with an on-chain verifier (M7).

### Sepolia progress

| Item | Status |
|---|---|
| Network config (chain id, explorer, faucet link) | ✅ unit-tested |
| RPC key server-side only (`EVM_RPC_11155111` in `.env`) | ✅ not in source, build output or git history |
| Connection check: latest block and chain-id verification before balances and before signing | ✅ unit-tested; RPC reachable and reports `0xaa36a7` |
| wallet-api disables an upstream whose `eth_chainId` doesn't match its configured chain | ✅ compiles and passes `go test ./...` (Go toolchain in `golang:1-bookworm`); a live mismatched upstream has not been exercised |
| Real ETH balance, receive screen with copy and faucet guidance | ✅ implemented; build passes |
| Send: gas-limit bug fixed (see below) | 🚧 fix verified by a live dry run (`eth_call`); a successful live send is still to be confirmed |
| Sepolia transaction history from the backend | ✅ enabled in `.env` (`HISTORY_PROVIDER_11155111=alchemy`); `GET /v1/activity` answers 200 with the provider's transfers |
| Activity list survives a provider item with no flags | ✅ server now always serialises `flags` as an array (openapi requires it), client defaults it; was a `Cannot read properties of null` crash |
| One network table for client and server | ✅ `docs/api/networks.json`, asserted from both sides ([ADR 0015](docs/adr/0015-one-network-table-asserted-from-both-sides.md)) |
| Network selector lists only chains the API can reach | ✅ gated by `GET /v1/networks`; Settings labels a chain the backend does not proxy, and a custom RPC still bypasses the gate |
| Fee quoting knows the difference between chains | ✅ `feeStrategy` in the registry selects the model ([ADR 0016](docs/adr/0016-per-chain-fee-strategies.md)): Ethereum keeps fee-history tiers, Base adds the OP-stack L1 data fee, Arbitrum prices from `eth_gasPrice`, Polygon lifts its tip to the chain minimum. Unit-tested against a fake node — 🚧 the first quote against a live rollup is still to come |

### Fixed: native transfers to new accounts failed out of gas

The first two Sepolia sends (`0x9343eeea…2d64e`, `0xd447a5b5…cadad4`) were mined with status `failed`, a gas limit of 21,000 and all of it used. The EVM adapter skipped `eth_estimateGas` for any recipient without contract code and hardcoded 21,000 gas. On Sepolia today, a transfer that creates a never-used account costs ~207,000 gas (a transfer to an existing account costs ~12,000), so 21,000 is not a safe constant. The adapter now always asks the node for an estimate, adds a 20% margin and floors the result at 21,000. A failed estimate stops the send instead of guessing. Regression tests are in `packages/evm/test/evm.test.ts`.

## Rollup testnets

Base Sepolia, Arbitrum Sepolia and Polygon Amoy are enabled the same way as Sepolia: one `EVM_RPC_<chainId>` line in `.env`, plus the chain declared in all three registries ([runbook](docs/operations/enable-an-evm-chain.md), [ADR 0015](docs/adr/0015-one-network-table-asserted-from-both-sides.md)).

| Network | Chain id | RPC source | Activity history |
|---|---|---|---|
| Ethereum Sepolia | `11155111` | Alchemy | Alchemy |
| Arbitrum Sepolia | `421614` | Alchemy, public RPC as a second upstream | Alchemy |
| Base Sepolia | `84532` | public (`https://sepolia.base.org`) | none |
| Polygon Amoy | `80002` | public (`https://polygon-amoy.drpc.org`) | none |
| Localhost (Anvil) | `31337` | the local node | local scanner |

The Alchemy app configured here answers `403` for Base Sepolia and Amoy, so those two run on public endpoints. Balances, fees and sends work; **Activity stays empty** because there is no history provider behind them. Enabling those networks on the Alchemy app and adding `HISTORY_PROVIDER_84532` / `HISTORY_PROVIDER_80002` is what changes that.

Verified live: each chain passes wallet-api's `eth_chainId` check, is listed by `GET /v1/networks`, appears in the network selector and reports a block number — `apps/web/e2e/multi-network.spec.ts`. Not verified: a fee quote against a real rollup, which is the remaining gate in [ADR 0016](docs/adr/0016-per-chain-fee-strategies.md). The Receive screen shows no faucet link for these three because we have not verified a faucet URL rather than guess one; use the provider's own faucet.

## Tests

```bash
make test-ts                                            # unit tests (all TS packages)
ANVIL_RPC_URL=http://127.0.0.1:8545 pnpm -r test        # + Anvil integration
make test-go                                            # Go unit tests
pnpm --filter @qd/web build && make e2e                 # Playwright (desktop + mobile)
E2E_API_URL=http://localhost:8080 make e2e              # include the full-stack suite
```

**Which E2E config to use.** `playwright.config.ts` serves the static build on `:3100`, but wallet-api only answers CORS for `ALLOWED_ORIGINS` (`http://localhost:3000` by default), so on that port every backend call is blocked and the wallet shows "Can't reach …". Either add `:3100` to `ALLOWED_ORIGINS` when you want the static build, or run against the dev server:

```bash
make web                                                # terminal 1 — :3000
pnpm --filter @qd/web exec playwright test --config=playwright.local.config.ts --project=desktop
```

`playwright.local.config.ts` is the same suite pointed at `:3000`; it covers the wallet flows and the Sepolia history screen, and only `serves strict security headers` fails there, because that one asserts the production CSP the dev server does not send. Run it from the `:3100` config to check the headers.

Known issue: none for the unit-test run. `apps/web` now has a `vitest.config.ts` that limits the sweep to `src/**`, so `pnpm -r test` no longer picks up the Playwright specs in `e2e/` (which fail outside a Playwright runner). There is no lint script yet.

Go tests need a Go 1.x toolchain. `make test-go` assumes it is installed; on a machine without one, run the same tests in a container:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v D:/wallet:/src -w /src/services/wallet-api \
  golang:1-bookworm sh -c 'go vet ./... && go test ./...'
```

## Security model in one paragraph

Keys are generated and used only on the device, inside a dedicated Web Worker. The recovery phrase is encrypted with Argon2id + AES-256-GCM and never leaves the browser. The device builds every transaction, decodes the review screen from the exact bytes being signed, and signs only with a single-use confirmation token bound to those bytes. The backend authenticates devices with non-extractable P-256 keys, proxies RPC so that provider keys stay private, and cannot move funds. The known residual risk of a hosted web wallet (malicious code delivery) is documented in ADR 0005.

## Local development notes

- Reloading the page **locks the wallet** by design: unlocked keys live only in worker memory.
- On Windows with a 32-bit MinGW gcc, run Go with `CGO_ENABLED=0` (go-ethereum falls back to its pure-Go crypto). The `-race` detector needs cgo and runs in CI instead.
