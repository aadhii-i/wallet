# ADR 0003: Viem without Wagmi inside the wallet

- **Status:** Accepted
- **Spec:** D7
- **Date:** 2026-09-24

## Context

Wagmi is a dApp-side connector library; QD Wallet is the wallet.

## Decision

Use viem directly with a custom transport to the wallet-api proxy, plus TanStack Query for caching. dApp connectivity (later) uses WalletConnect WalletKit.

## Consequences

One less abstraction layer; wagmi may still be used for an internal dApp test harness.
