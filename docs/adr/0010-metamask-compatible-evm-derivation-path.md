# ADR 0010: MetaMask-compatible EVM derivation path

- **Status:** Accepted
- **Spec:** §14
- **Date:** 2026-09-24

## Context

Users expect the same phrase to show the same accounts in MetaMask.

## Decision

`m/44'/60'/0'/0/{index}`; verified against the Anvil/Hardhat vectors and viem.

## Consequences

Ledger Live-style paths are not discovered in V1.
