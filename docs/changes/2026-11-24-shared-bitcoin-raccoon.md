# Shared Bitcoin implementation — 24 November 2026

## What we contributed

We implemented the approved shared Bitcoin custody model: independent native
Bitcoin keys, majority P2WSH multisignature, and Threshold Raccoon approval before
each honest worker releases its native signature. This extends Adhil's shared
account setup without replacing its Ethereum smart-account execution model.
The [decision record](../adr/0022-shared-bitcoin-native-multisig-and-raccoon.md)
explains the precise security guarantees and limitations.

## Low-level implementation map

| Layer | Implementation and purpose |
|---|---|
| Wallet core | A separate hardened deterministic namespace for each participant's native Bitcoin keys; callback-scoped private-key access and wiping; Bitcoin-specific confirmation payloads. |
| Bitcoin engine | Proved native enrollment, canonical safety fingerprint, sorted P2WSH scripts, confirmed coin selection, exact proposal validation, Raccoon round combination/verification, per-input native signing, quorum finalization. |
| Key worker | Local policy pinning and explicit proposal approval; three Raccoon rounds; permanent session burn records; atomic native-signature reservations; saved final bytes. |
| Encrypted share store | Retention of this device's pinned-policy share across later source-share replacement and password rotation. It retains no other participant's share. |
| API and database | Registered-device-signed public-message relay scoped to wallet/account/key generation/membership; immutable phases, retries, limits, memory snapshot and PostgreSQL persistence. |
| Frontend | Shared account selection, key registration, safety-number comparison, separate funding address, confirmed balance discovery, proposal review, explicit approval, signing progress and explicit final submission. |
| Existing personal Bitcoin | P2WSH is accepted as a payment destination, allowing funding of a shared account. Existing receive addresses and personal signing modes remain unchanged. |
| Network guard | Configured Bitcoin upstream must return the expected genesis before shared discovery, review or submission. A mismatched provider fails closed. |

The new implementation is concentrated in the Bitcoin package's shared module,
the shared Bitcoin frontend panel and discovery helper, worker operations, and
the API's Bitcoin shared-message relay. Migration 14 stores public messages.
The personal fresh-change implementation is documented in its
[separate milestone](2026-11-24-bitcoin-change-security.md).

## Validation and evidence boundary

Eight focused engine tests passed with the isolated Bitcoin Core executable
enabled. They cover real serialized Threshold Raccoon rounds and native
signatures, invalid/expired approvals, altered transaction details, foreign keys,
weakened policy, duplicate signatures, locale-independent native key ordering
and canonical policy fingerprints.

The Bitcoin Core regtest case mined native multisignature funds, verified local
mempool acceptance, submitted and confirmed a payment, restored the native keys,
and spent its fresh shared change. This proves local consensus compatibility;
it is not evidence of a public Testnet4 transaction.

Relay tests cover authenticated device binding, altered signatures, account
isolation, stale membership, immutable retries, snapshot restart and concurrent
proposal conflicts. A disposable PostgreSQL database applied the migration and
passed concurrent relay persistence and existing store tests under the race
detector. An encrypted-store test checks that archived Bitcoin shares survive
source replacement and password rotation.

The browser acceptance scenario exercises three independent devices, real
encrypted share provisioning, native enrollment and policy confirmation,
networked Raccoon rounds, native signatures and explicit final submission.
Bitcoin funding responses and submission are simulated in that scenario;
the native consensus check is the separate Bitcoin Core test above. The shared Ethereum regression journey also completed successfully on local
Anvil, including contract execution, wallet history and gas-service checks.
These local environments carry no real funds.

## Current limits and next work

Mainnet is disabled. This is a research preview, not release-ready custody.
Bitcoin enforces native ECDSA multisignature and cannot enforce the off-chain
Raccoon gate. A colluding native quorum can bypass it. Trusted-dealer provisioning
remains; no distributed key generation or native threshold MPC was added.

Before release we need full policy/share backup and restoration, archived-policy
access after membership changes, coordinated fund migration, signer selection,
conflicting/abandoned proposal recovery, fee-bumping and improved saved-payment
retry screens. The current panel explicitly tells users to keep membership
fixed and preserve encrypted device share storage during testing.
Public Testnet4 verification, independent security review and performance
measurements remain outstanding. No public transaction was authorized or executed
for this implementation. Publication follows the project owner’s separate
explicit instruction to push the verified work to GitHub main.

## Verification checkpoint — 25 November 2026

| Check | Observed result |
|---|---|
| Bitcoin package with offline Bitcoin Core enabled | 37 automated tests passed, including shared multisignature/Raccoon and both personal SegWit/Taproot restored-change cases. |
| Default workspace automated suites | 509 tests passed; 26 environment-gated tests skipped. The separate Bitcoin Core and browser runs below enable additional coverage. |
| Shared browser acceptance | The complete shared Bitcoin plus Ethereum/Anvil journey passed against a fixed build. After the final key-ordering change, the dedicated three-device Bitcoin mode also passed against a freshly built frontend. Bitcoin network responses remain simulated. |
| Real Chromium cross-tab storage | One test passed for atomic reservation and rollback. |
| Workspace type checking | All 11 tasks passed; the production build also type-checked the final worker/frontend. |
| Production frontend build | Passed; 17 routes exported. |
| Go backend | Full race-detector suite and static analysis passed. Database/public-network gated tests are not implied by that default run. |
| Disposable PostgreSQL | New relay concurrency/persistence and existing store tests passed under the race detector after migration 14. Fresh-database migrations were run sequentially across packages. |
| Public blockchain transactions | None executed. Public Testnet4 functionality remains manually unverified. |

The API specification's new relay and identity routes are documented. Two
pre-existing indentation errors in fee-estimate field documentation were also
corrected so the YAML parses; no EVM fee behavior was changed.

An intermediate browser rerun overlapped an active frontend rebuild and later
encountered a locked wallet on navigation. That run is retained separately as
invalidated verification evidence; it is not counted as a passing run. Final
browser verification uses a fixed build with no concurrent rebuild.
