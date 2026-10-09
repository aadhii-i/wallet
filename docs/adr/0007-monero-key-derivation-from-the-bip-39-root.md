# ADR 0007: Monero key derivation from the BIP-39 root

- **Status:** Proposed — M5 spike
- **Spec:** D3
- **Date:** 2026-09-24

## Context

Monero has no native BIP-39 derivation.

## Decision

Adopt an existing hardware-wallet-compatible scheme only if its published vectors reproduce; otherwise use a separate Monero seed.

## Consequences

Never invent a derivation.
