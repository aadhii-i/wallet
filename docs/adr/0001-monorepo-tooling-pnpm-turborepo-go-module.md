# ADR 0001: Monorepo tooling: pnpm + Turborepo + Go module

- **Status:** Accepted
- **Spec:** §6.3
- **Date:** 2026-09-24

## Context

TS packages are shared between web and (future) mobile; the Go service is independent.

## Decision

pnpm workspaces with source-level `exports` (no per-package build step; Next transpiles them). Turborepo orchestrates tasks. `services/wallet-api` is a standalone Go module.

## Consequences

Fast iteration and one lockfile. Packages must stay framework-free so React Native can consume them.
