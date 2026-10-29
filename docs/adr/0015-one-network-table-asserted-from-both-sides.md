# ADR 0015: One network table, asserted from both sides

- **Status:** Accepted
- **Spec:** §11.3 ("the registry is data")
- **Date:** 2026-10-18

## Context

Spec §11.3 assumes a single registry, but the wallet has two: the TypeScript client table (`packages/blockchain/src/networks.ts`) and the Go server table (`services/wallet-api/internal/blockchain/evm/network.go`). They had already drifted — the server reported Sepolia's native symbol as `ETH` (the client says `SepoliaETH`) and labelled any chain it did not recognise as `mainnet`, which would show a testnet balance in a real-funds badge.

## Decision

`docs/api/networks.json` is the canonical list of EVM chains and of the fields both registries model (`id`, `chainId`, `name`, `kind`, `nativeSymbol`, `nativeDecimals`). Both test suites assert against it: `packages/blockchain/test/networks-contract.test.ts` for the client, `services/wallet-api/internal/blockchain/evm/network_test.go` for the server, each checking both directions, so a chain added on one side alone fails CI. Client-only presentation fields (explorer, accent, `feeModel`, confirmations, faucet link) stay in TypeScript.

A chain id configured server-side but absent from the table gets `kind: unknown`, never a guessed `mainnet`; the UI renders that as `Unrecognised`. `unknown` is a server-side value only — the client table may never declare it.

## Consequences

Adding a chain is now a three-file change (JSON, client table, server table) with the CI pair proving the other two were touched. The two tables still duplicate values by hand; promoting the JSON to a code generator, or serving the client table from `/v1/networks`, is the natural follow-up (Batch 2).
