# ADR 0012: Append-only hash-chained audit log

- **Status:** Accepted
- **Spec:** §9.6
- **Date:** 2026-09-24

## Context

Insiders with DB access must not be able to silently rewrite history.

## Decision

Each row stores `prev_hash` and `row_hash = SHA-256(prev_hash || canonical_json(row))`; `VerifyChain` detects tampering. External anchoring of the head hash is planned for M6.

## Consequences

Detection, not prevention; the DB role should be INSERT/SELECT only.
