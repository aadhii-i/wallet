# ADR 0011: Prices fetched by the backend for the whole token list

- **Status:** Accepted
- **Spec:** D10
- **Date:** 2026-09-24

## Context

Per-user price lookups at a third party leak portfolios.

## Decision

`GET /v1/prices?ids=` served from a 60 s cache; static provider in dev, CoinGecko in production.

## Consequences

Fiat values disappear gracefully when the price service is down.
