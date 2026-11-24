# Wallet integration checkpoint — 24 November 2026

This checkpoint brings the existing multi-chain implementation, shared-wallet
implementation, stabilization work, and subsequent local fixes together on main.
It preserves the existing shared-wallet architecture and signing protocol.

## Included work

The combined version retains Ethereum/EVM, Bitcoin SegWit and Taproot, and
Hedera account and transfer flows alongside shared-wallet provisioning,
Threshold Raccoon signing, and contract-account execution. Monero remains at
its existing implementation status; this merge does not complete that integration.

RPC read handling coalesces duplicate requests, retries eligible read failures,
preserves caller response identifiers and upstream error data, and distinguishes
rate limits from unhealthy upstream nodes. Transaction submission remains separate
from read retries.

Shared-wallet funding estimates include Base L1 data and operator fee reserves,
Arbitrum posting reserves and its gas-price model, and the Polygon node's gas-price
floor. Polygon Amoy amounts and receipts display POL. These are conservative
budgets, not promises of the final transaction cost. Arbitrum posting reserves
affect funding diagnostics; they are not added again to the estimated signed gas
limit.

## Validation and limits

The integration was checked with workspace type checking and automated tests,
backend tests and static analysis, and a production frontend build. Live-network
tests are opt-in; skipped live tests do not constitute transaction evidence.
The fee-model regression tests use controlled chain responses and locally
generated signing keys. They do not broadcast public testnet transactions.

This checkpoint does not establish production readiness or eliminate the need
for manual network testing, cryptographic review, independent security auditing,
and performance evaluation. Existing progress reports remain historical reports.

The original development workspace and its uncommitted files are retained
separately. Local settings, credentials, wallet data, generated build metadata,
and test-output artifacts are excluded from the integration commit.
