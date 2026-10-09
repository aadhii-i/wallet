# ADR 0004: Web vault: Argon2id + AES-256-GCM in IndexedDB, inside a Web Worker

- **Status:** Accepted
- **Spec:** D5, §7.2
- **Date:** 2026-09-24

## Context

Web users need persistence without ever storing the phrase in plaintext.

## Decision

Vault v1 = Argon2id (m=64 MiB, t=2, p=1; minimum accepted m=19 MiB, t=2) → AES-256-GCM, header bound as AAD. Stored only by the KeyWorker in IndexedDB. Decrypted material lives only in worker memory; a page reload locks the wallet. Brute-force: 5 free attempts then exponential delay (max 5 min).

## Consequences

~1.4 s unlock in Node, somewhat slower in browsers. Pure-JS Argon2 (noble) keeps the audited-library rule; revisit a WASM build for speed.
