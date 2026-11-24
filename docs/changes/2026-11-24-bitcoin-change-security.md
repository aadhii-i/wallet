# Bitcoin change and UTXO security - 24 November 2026

## Problem and resulting behavior

Previously Bitcoin change returned to the sending address, balances read one
address, and the worker signed with one key. This milestone adds internal change
derivation, account-specific discovery, aggregated balances/history, multi-key
input signing, and saved signed-payment recovery. Existing receive addresses
remain unchanged. Adhil's shared-wallet and Threshold Raccoon code is unchanged.

Selected previous transactions are checked by their raw bytes, transaction IDs,
output indexes, amounts and scripts. Duplicate/malformed outputs, unconfirmed
coins, immature coinbase outputs, unsupported signature modes, foreign inputs,
unexpected recipients/change, and excessive fees are rejected at the relevant
preparation/signing boundaries. Spend status is refreshed before signing and
broadcasting. Concurrent tab reservations and signature persistence are atomic.

The send screen explains returned change and offers explicit retry of saved
signed transactions. Retrying submits the original bytes; it does not sign a
second payment. The Max calculation now leaves room for fees. Confirmation
counts use the provider's tip/block height instead of a fixed value of one.

## Implementation map

- `packages/wallet-core`: backward-compatible internal derivation, scoped key
  access, and confirmation binding to explicit Bitcoin review fields.
- `packages/bitcoin`: UTXO/previous-output validation, fee/dust policy, scoped
  coin discovery, PSBT construction, output validation, and per-input signing.
- `apps/web`: worker ledger, atomic IndexedDB updates, change discovery,
  account/balance/history integration, saved-payment UI, and import discovery.
- `services/wallet-api/internal/blockchain/btc`: raw transaction and activity
  reads, confirmation calculation and hostile-data validation.
- `packages/rpc` and `docs/api/openapi.yaml`: typed client methods and contracts.

## Validation evidence

The full enabled local TypeScript run passed 513 tests, with 12 gated/utility
cases skipped. Backend tests passed with the race detector, and static analysis
passed. All four desktop/mobile browser cases passed, covering both normal
payment/reload/change-spend and interrupted-broadcast recovery, against simulated
Esplora data. Production build, workspace type checking and the redacted secret
scan also passed. These results are not public-network
transaction evidence.

- Bitcoin library tests cover malicious UTXOs, previous-output substitution,
  confirmation binding, change derivation, multi-input SegWit/Taproot spending,
  fee limits, and spent-coin revalidation.
- Web tests cover discovery failure, allocated-address cache invalidation,
  spent change discovery, account-level history classification and reservations.
- A real Chromium test verifies cross-tab IndexedDB serialization and rollback.
- Bitcoin Core 32.1 regtest tests start isolated offline nodes, mine funds,
  submit and confirm a payment, restore keys, then spend its change into a fresh
  internal address. Both SegWit and Taproot cases passed. This is local Bitcoin
  consensus/policy validation, not a public Testnet4 transaction.
- Backend tests cover malformed/duplicate outputs, invalid heights, missing tip,
  raw-transaction boundaries, wrong configured network, and activity failures.

Environment-gated tests remain explicitly gated: `BITCOIND_BIN` selects the
regtest executable; `QD_BITCOIN_BROWSER_TESTS=1` enables the real Chromium storage
test. The isolated `playwright.bitcoin.config.ts` uses a static build targeting
localhost:8183 and a separate preview on port 3102, with simulated Esplora
responses. It does not disturb the existing review instance.

## Limits and rollback

Only test tooling adds a dependency: Bitcoin's Node type definitions use the
same pinned version already present elsewhere in the workspace. Runtime
dependencies and Adhil's shared-wallet protocol are not changed.

See [ADR 0021](../adr/0021-bitcoin-change-recovery-and-utxo-validation.md) for
recovery bounds, provider trust, cross-device limitations and remaining release
work. No public-chain transaction was authorized or executed in this milestone.
No claim of audit completion or quantum-safe native Bitcoin signing is made.

After funds are sent to internal change, do not roll back to a build that only
reads the legacy address. Retain the recovery phrase and use a compatible build
or the documented derivation paths to recover change. The ledger holds public
metadata and signed transactions, not private keys. Clearing it loses local
reservation/broadcast recovery information, although on-chain keys remain
deterministically recoverable.

## Threshold Raccoon follow-up

The owner requested a design for Raccoon approvals plus native Bitcoin signing.
The [proposal](../architecture/bitcoin-raccoon-approval-proposal.md) documents
custody choices, key-holder bypass, commitment binding and review gates. It is
the design that preceded the separately approved
[shared Bitcoin implementation](2026-11-24-shared-bitcoin-raccoon.md).
