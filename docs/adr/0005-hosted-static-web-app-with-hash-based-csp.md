# ADR 0005: Hosted static web app with hash-based CSP

- **Status:** Accepted (residual risk)
- **Spec:** D4, §7.5
- **Date:** 2026-09-24

## Context

A hosted wallet reloads its signing code from the server on every visit.

## Decision

Next.js `output: export`. `scripts/csp.mjs` hashes every inline script and emits per-route headers (`out/_headers`): no `unsafe-inline`/`unsafe-eval` for scripts, `default-src none`, `frame-ancestors none`. API on a separate origin.

## Consequences

Compromise of hosting/CDN/build remains able to ship malicious code (documented). Mitigations to add in M8: reproducible builds with published hashes, IPFS mirror, browser extension.
