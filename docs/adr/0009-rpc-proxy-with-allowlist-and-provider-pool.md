# ADR 0009: RPC proxy with allowlist and provider pool

- **Status:** Accepted
- **Spec:** §25
- **Date:** 2026-09-24

## Context

Provider keys must stay server-side and upstream failures must be survivable.

## Decision

Authenticated JSON-RPC proxy with method allowlist, batch ≤ 20, bounded eth_getLogs, per-provider rate limit + circuit breaker + health probe, read-only failover, and no blind re-send of raw transactions. Users may configure a custom RPC that bypasses us (chain id verified).

## Consequences

Single point of availability, mitigated by the custom-RPC escape hatch.
