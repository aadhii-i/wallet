# Native shared-wallet hardening — 26 November 2026

## Result and contribution boundary

We extended our native Bitcoin/Hedera work with recovery, signing safeguards and
the approved coordinated membership migration. We reuse Adhil's shared-wallet
identities, participant setup, trusted-dealer provisioning, Raccoon engine and
EVM execution. The owner approved the lifecycle change in ADR 0024. No rewrite
of the Raccoon algorithm, distributed key generation or native MPC is claimed.
The changes are local and uncommitted. GitHub main and every visible remote
branch were checked; no missing commit was found. Adhil's latest visible
stabilization commit is already included.

## Delivered behavior

| Area | Implemented behavior |
|---|---|
| Bitcoin recovery | Portable password-encrypted own-share backup with native policy, reservations, change cursor, signed partials and finalized transactions. Wrong wallet/password and changed evidence fail validation. |
| Signing freshness | Bitcoin version 2 sessions combine fresh randomness from selected participants. Workers verify their own contribution, retain permanent session burns and never restore secret rounds or old consent. |
| Bitcoin spending | Confirmed previous-output checks, deterministic fresh change, explicit signer selection, saved-byte retry, history and conservative reconciliation. Signed inputs stay reserved even when a transaction is not found. |
| Change exhaustion | The supported change range cannot be exceeded. Its exhausted cursor remains valid for backup, recovery and a sweep without change. |
| Hedera shared accounts | Separate native participant keys, majority threshold accounts, reviewed account creation, full-key linking, exact HBAR balances, history, Raccoon approvals and native signatures. |
| Hedera rotation | Same frozen account-key update reviewed by both groups; separate old/new Raccoon approvals and both native quorums; saved final bytes and independently revalidated encrypted recovery. |
| Membership safety | Immediate invitation/join/revocation is blocked once native custody is enrolled. Native key control cannot be revoked by editing a database roster. |
| Coordinated migration | Replacement group through existing provisioning, both-group review confirmations, frozen ordinary native proposals, registered signing attempts and read-only result verification. |
| Bitcoin migration evidence | Exact nominated output snapshot, one replacement destination, bounded batches and six-confirmation coverage for every nominated coin. No inference from an empty UTXO list. |
| Partial recovery | Persistent revision-checked state, previous evidence retained, fee/snapshot-only revised reviews requiring fresh confirmations from both groups. No automatic chain rollback. |
| Activation | Replacement native spending resumes after every nominated account is verified. Later read failures raise a warning rather than silently undoing historical activation. |
| Public-message integrity | Registered reviews remain distinct from real authenticated relay messages. Go and browser code independently validate policies and the canonical review commitment. |

The replacement lifecycle concerns native Bitcoin and Hedera. Existing EVM
accounts stay in their original group and use their existing approval workflow.
Other Bitcoin coins, omitted dust and late deposits continue to need the old
native quorum. Keep the old group and its encrypted recovery data.

## Evidence observed locally

- Workspace automated tests: **533 passed, 26 skipped**, across twelve task groups.
  Skips include opt-in network/integration cases and utilities; they are not
  successful public-chain tests.
- All twelve workspace type-check tasks and the seventeen-route production
  frontend build passed.
- The backend test suite passed with the race detector; backend static analysis
  passed.
- Disposable PostgreSQL checks passed for native membership locking, both native
  relays and migration persistence. Fresh migrations include the Hedera relay,
  native custody guard and native migration records. The persistence test also
  rejects competing migrations and stale writes.
- The separately enabled Bitcoin Core regtest shared-wallet suite passed all
  eight tests. It verifies native quorum payments, change spending and mempool
  acceptance of the new one-output migration sweep to an independent group.
- Worker tests exercise real independent native signatures and Raccoon rounds,
  encrypted recovery and two-group Hedera key updates. Public fixture contracts
  cross-check Go policy IDs, Bitcoin addresses, Hedera threshold keys, frozen
  transaction parsing and browser review hashes.
- The three-profile Hedera browser journey passed against local Mirror/HAPI
  simulation, including shared creation, HBAR transfer, receipts and history.
  Its added migration-screen checks exercise review rendering and fail-closed
  behavior for a changed review commitment without approving or signing it.

The Bitcoin/EVM three-profile browser regression also passed, including shared
Bitcoin signing and the existing two-of-three EVM signing/contract execution
against local Anvil.

- The combined shared Bitcoin/EVM browser regression also passed. It exercises
  native Bitcoin signing with the public-data fixture and two-of-three Raccoon
  execution through the existing EVM smart account on local Anvil.
- Secret scanning of the changed tracked/untracked source and documentation
  found no leaks. Public protobuf fixture fields identify their encoding
  explicitly; no scan rule or security exception was added. OpenAPI YAML parsed
  successfully and documents ten migration/inventory operations.

The worker, coordinator and rendering tests cover different layers. They do not
yet establish a complete two-group migration through a browser and a real chain.
No public Testnet transaction or mainnet transaction was performed for this work.

## Operator and recovery procedure

1. Back up every participant's encrypted share and policy. Retain the correct
   recovery phrase and the password used when exporting each backup. Reconcile
   existing signed operations before preparing a migration.
2. A healthy old participant creates a replacement shared group, invites the
   intended members, and completes its existing provisioning. Enroll and compare
   each target native policy. Do not create an unrelated funded Hedera account
   for the target when migrating the old Hedera account number.
3. From the old wallet, prepare account mappings and fee caps. Review the exact
   Bitcoin coin snapshot and both policy safety numbers. Both rosters confirm
   the same migration digest with their registered devices.
4. After both quorums freeze the review, prepare registered native signing
   attempts. Preparation does not sign or submit. Each participant explicitly
   approves the operation, and a separate action submits finalized bytes.
5. For Bitcoin use batches of at most 100 nominated inputs. For Hedera complete
   both groups' Raccoon and native signatures within its signing window. Check
   saved results before preparing a replacement attempt after a timeout.
6. Run read-only chain verification. Uncertain delivery stays partial. If fees
   or the coin snapshot need changing, prepare a revised review and obtain both
   groups' confirmations again. Its destinations and participant policies cannot
   be changed. Old signed operations can still confirm under earlier authority.
7. After completion, use the replacement for native accounts. Every incoming
   Hedera participant links and confirms the unchanged numeric account ID.
   Keep the old Bitcoin group for residual and later coins. Do not delete old
   recovery data on the assumption that an application label revokes old keys.

## Release gates and operational limits

This is implemented release hardening, **not production release certification**.
Native transactions still use conventional cryptography. A colluding native
quorum can sign outside the application without Raccoon. Trusted-dealer
provisioning and conventional device authentication remain.

Before a public release we need authorized public Testnet consensus evidence,
a complete two-group browser migration journey, independent cryptographic and
application review, device-authorization recovery after storage/device loss,
archived-epoch recovery, and performance/failure evaluation. A share backup alone
does not restore server authorization or replace a lost native quorum.

The implementation supports Bitcoin Testnet4 and Hedera Testnet HBAR. It does
not add shared Bitcoin Taproot, Hedera token transfers or scheduled signing.
Hedera currently uses a short signing window and one frozen node transaction;
outages require reconciliation and an explicitly reviewed fresh attempt.
Configured Esplora/Mirror responses are trusted chain views, not independent
consensus proofs. Storage and scanning are bounded: up to sixteen native
migration accounts, 1,000 nominated Bitcoin coins, 100 inputs per sweep, sixteen
revised reviews and 1,000 retained attempt records. Exhaustion fails closed and
needs recovery review; it must not trigger silent deletion of signed evidence.

## References

- [Approved release-hardening decision](../adr/0024-native-shared-wallet-release-hardening.md).
- [Shared Hedera implementation](2026-11-26-shared-hedera.md).
- [Supervisor contribution report](../contributions/QD-Wallet-Contribution-Report.md).
