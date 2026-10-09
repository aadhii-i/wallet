# QD Wallet

A non-custodial, multi-chain wallet (Ethereum / EVM now, Monero and QD/MPC signing later) with a web client, a Go backend and shared TypeScript wallet libraries.

- **Specification:** [docs/architecture/qd-wallet-v1-technical-spec.md](docs/architecture/qd-wallet-v1-technical-spec.md)
- **Decisions:** [docs/adr/](docs/adr/README.md)
- **API contract:** [docs/api/openapi.yaml](docs/api/openapi.yaml)

> Status: **V1 preview — testnet/local use only.** Not audited. Do not use with real funds.

## What works today

| Milestone | Status |
|---|---|
| M0 Spec, ADRs, API contract, schema | ✅ |
| M1 Wallet core (BIP-39, BIP-32/44, encrypted vault, HD signer) | ✅ tested against official vectors and viem |
| M2 Ethereum: balances, fees, send, receive, history, tracking | ✅ verified end-to-end on Anvil |
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

## Tests

```bash
make test-ts                                            # unit tests (all TS packages)
ANVIL_RPC_URL=http://127.0.0.1:8545 pnpm -r test        # + Anvil integration
make test-go                                            # Go unit tests
pnpm --filter @qd/web build && make e2e                 # Playwright (desktop + mobile)
E2E_API_URL=http://localhost:8080 make e2e              # include the full-stack suite
```

## Security model in one paragraph

Keys are generated and used only on the device, inside a dedicated Web Worker. The recovery phrase is encrypted with Argon2id + AES-256-GCM and never leaves the browser. The device builds every transaction, decodes the review screen from the exact bytes being signed, and signs only with a single-use confirmation token bound to those bytes. The backend authenticates devices with non-extractable P-256 keys, proxies RPC so that provider keys stay private, and cannot move funds. The known residual risk of a hosted web wallet (malicious code delivery) is documented in ADR 0005.

## Local development notes

- Reloading the page **locks the wallet** by design: unlocked keys live only in worker memory.
- On Windows with a 32-bit MinGW gcc, run Go with `CGO_ENABLED=0` (go-ethereum falls back to its pure-Go crypto). The `-race` detector needs cgo and runs in CI instead.
