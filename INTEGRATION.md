# QD-Wallet integration

## Source and scope

The integrated source starts with the current `D:\wallet` working copy on `hedera-phase2b` at `0b00bba`, including tracked edits and the untracked Bitcoin package, API, and network-family migration. The shared-wallet changes are pinned to GitHub commit `653116da7227b8d0685c75413b64f8b7de656550`. The common base is `a90db57`. The separate `hedera-verified` worktree had a different set of local changes and was left as an independent reference. The integration was built in a copy without Git metadata, credentials, local database or browser data, and generated build and test output.

| Area | Result |
| --- | --- |
| Personal wallet | The EVM transaction and proof paths, Bitcoin SegWit and Taproot PSBT paths, and the Hedera transfer and account paths remain available through the multi-chain UI and API. |
| Shared wallet | Includes membership, invitations, approvals, the trusted-dealer ceremony and HPKE share delivery, encrypted device shares, Threshold Raccoon rounds, QdAccount contracts and relayer, gas service, indexed wallet history and receipts. |
| KeyWorker | Keeps HD and Bitcoin signer initialization and Hedera payload handling. Lock clears the confirmation registry, share-store key and in-flight signing sessions. Shared wallet commands use their own protocol and encrypted store. |
| Configuration and API | Includes both Bitcoin and shared-wallet endpoints, provider configuration, the common OpenAPI specification, and a single regenerated pnpm lockfile. Shared-wallet proposal creation and relayer execution are limited to test networks: Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Polygon Amoy and local Anvil. Every mainnet is rejected (see [the 2026-11-20 change](docs/changes/2026-11-20-restore-shared-wallets.md)). |
| Database | Retains `00002_addresses_network_families.sql` and moves the six GitHub migrations from `00002–00007` to `00008–00013`. The Bitcoin design record moved to ADR 0020 to resolve a separate numbering collision. |

## Run and roll back

Use a fresh checkout of this archive and a separate browser profile and development API. Install with `pnpm install --frozen-lockfile` using pnpm 9.15.0. Go tests run with `go test ./...` in `services/wallet-api`, and frontend tests run with `pnpm -r test` from the root. See the root and web `.env.example` files. Shared Wallets is off by default. `ENABLE_SHARED_WALLETS=true` enables the API routes and `NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true` enables the UI at build time. Relayer execution also needs a configured Sepolia RPC and a development relayer key. The Playwright shared-wallet setup uses a disposable local Anvil node with Sepolia's chain ID.

Use a fresh database or a verified copy of the multi-chain baseline database. Databases initialized on GitHub's shared-wallet version or the separate Hedera verification worktree have different meanings for migration 2. They require an explicit migration-history reconciliation before use with this build. Turn the two shared-wallet flags off to roll back access and automated execution while retaining schema and share data. Once test accounts have enrolled, preserve their device share stores and execution records. A personal-wallet recovery phrase cannot recover a lost shared-wallet share.

## Verification

- The source comparison retained 331 files from the multi-chain baseline and included 155 source paths changed by the GitHub commit. Renamed migrations and the Bitcoin ADR were checked at their new paths. Generated files were excluded from the comparison.
- The frozen pnpm lockfile check, workspace TypeScript checks, and production web build passed. The TypeScript suites passed 474 tests. The web suite was rerun after the final type fixes and passed 195 tests.
- The Go test suite and Go vet passed. Local API checks verified the default-off routes, authenticated access when enabled, and rejection of a non-Sepolia shared proposal.
- The merged OpenAPI document parsed and contained 58 paths.
- A disposable PGlite database passed the fresh install and the upgrade from the multi-chain schema. Shared migrations rolled back and reapplied while preserving fixture EVM, Bitcoin, and Hedera addresses. Goose and the PostgreSQL store tests also passed over the PGlite socket, as did selected key generation, signing, relayer, gas service, and history tests. The concurrent cases passed with the in-memory store. Their behavior on a standalone PostgreSQL server remains unverified because PGlite multiplexes a single connection.
- The production build exposed two TypeScript issues, fixed in the integrated copy. The database checks also exposed a first-entry audit-log error and timestamp precision mismatch. The integrated copy now stores an empty previous hash and hashes timestamps at PostgreSQL precision.
- Live chain tests and browser/Anvil end-to-end execution were skipped. No blockchain transactions were sent and no contracts were deployed during this integration.
