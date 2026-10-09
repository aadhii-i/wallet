# ADR 0002: Client-side transaction construction and signing

- **Status:** Accepted
- **Spec:** D6, §16
- **Date:** 2026-09-24

## Context

If the backend built payloads, a backend compromise could change what users sign.

## Decision

The device builds, describes and signs. `EvmAdapter.describe()` decodes the review summary from the exact unsigned bytes; the chain id comes from the client registry. The backend only proxies RPC, indexes history and tracks hashes.

## Consequences

Backend compromise cannot redirect funds. Fee/nonce data from the backend is sanity-checked client-side (gas bounds, nonce tracker, broadcast hash check).
