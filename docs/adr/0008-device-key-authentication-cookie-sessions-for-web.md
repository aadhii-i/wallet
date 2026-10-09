# ADR 0008: Device-key authentication; cookie sessions for web

- **Status:** Accepted
- **Spec:** §22
- **Date:** 2026-09-24

## Context

The backend must authenticate devices without passwords or wallet keys.

## Decision

Non-extractable P-256 device key signs `QDWallet-Auth|v1|origin|challengeId|nonce|issuedAt` (60 s, single use). The client refuses challenges naming another origin. Access JWT ES256 (10 min), rotating refresh tokens with family revocation on reuse. Web: `__Host-` HttpOnly SameSite=Strict cookies + CSRF header; `/v1/auth/*` exempt from CSRF but Origin-allowlisted.

## Consequences

Sessions cannot move funds; worst case is metadata access.
