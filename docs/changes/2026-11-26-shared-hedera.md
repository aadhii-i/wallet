# Shared Hedera integration — 26 November 2026

## What we implemented

We extended the shared-wallet setup with a separate Hedera Testnet account.
This builds on the existing personal Hedera work and Adhil's shared-account,
key-provisioning and Threshold Raccoon implementation. Ethereum and Bitcoin
continue to use their existing execution paths.

| Capability | Implementation |
|---|---|
| Native custody | Each participant holds a separate deterministic native key. Hedera's threshold account key requires a majority of those keys. |
| Enrollment | Native possession proofs and a common policy safety number, confirmed by every participant. |
| Account creation | A funded personal wallet pays the reviewed creation fee; its key remains inside the worker. The new account uses the complete shared threshold key. |
| Existing-account registration | Every participant verifies the full native key structure and pins the same account ID. A single matching public key cannot establish shared ownership. |
| Receive and balance | A separate shared numeric account ID, copy/explorer controls, exact tinybar balances and explicit unavailable states. |
| HBAR payments | Immutable proposals, chosen Raccoon signers, explicit review and approval, visible expiry and a maximum fee cap. |
| Threshold signing | Real networked Raccoon rounds and independent native signatures. Each native signer verifies Raccoon approval locally. |
| Submission and results | Saved native bytes, explicit submission, no silent transaction-ID regeneration and a required successful receipt. |
| Activity | Paginated incoming/outgoing HBAR history, exact amounts and fees, and HashScan links. |
| Pending transactions | Local reservations, saved creation/payment results, read-only reconciliation and identical-byte retry while still valid. |
| Encrypted recovery | Backup/import of this device's own share, policy and pending evidence. Native key and Raccoon context checks prevent import into another recovery phrase. |

## Low-level implementation and security

The new Hedera package owns native threshold policy construction, strict
transaction review, Raccoon approval verification and native signature assembly.
Wallet core exposes a separate deterministic shared-Hedera key namespace through
scoped callbacks. The dedicated Hedera worker controls policy pinning, local
approvals, signing sessions, reservations and recovery encryption.

The API relays registered-device-signed public messages, scoped to the current
shared account and membership epoch. A new database migration stores those
transcripts. Separate account-information and transaction-result reads preserve
the complete native key and integer amounts. Existing single-key personal
registration is not reused as evidence of threshold ownership.

Hedera transactions have a short native validity window. We display that deadline
and require new proposals after interrupted signing rather than reusing masks.
Each selected signer contributes fresh randomness to the actual Raccoon session,
including after a stale backup is restored. Native final bytes are persisted
before submission, and recovered evidence is checked against the original
reviewed body and enrolled signatures.

The full rationale, path specification and workflow are in
[ADR 0023](../adr/0023-shared-hedera-native-threshold-and-raccoon.md).

## Frontend workflow

Open the shared wallet after its participants, Raccoon shares and shared account
are initialized. In **Shared Hedera**, select the shared account. Each participant
unlocks their share storage, registers their native key, compares the displayed
policy safety number and confirms the policy.

The owner can review and create a native threshold account using a funded linked
personal Hedera account, or propose an existing account with the exact threshold
key. Each participant independently verifies and confirms the account. The shared
receive account and balance then become available. Export each participant's
encrypted share backup and retain its export-time password separately.

For a payment, enter a Testnet recipient, HBAR amount and fee cap, then select the
Raccoon signers and prepare the proposal. Every required signer reviews and
explicitly approves it. The wallets exchange Raccoon rounds and native signatures;
submission remains a separate button. After an uncertain result, check the saved
transaction before retrying. Keep the participant roster unchanged while funded.

Creation and submission incur real Testnet activity when used against Hedera.
The implementation checks did not authorize or execute those public operations.

## Validation and evidence boundary

Focused engine tests exercise actual Raccoon rounds, native signature
interoperability with Hedera's SDK, quorum enforcement, duplicate rejection,
mutated payment fields, full account-key checks and account-creation bytes.
Worker tests cover consent, pending reservations, encrypted backup restoration,
wrong-password and wrong-wallet rejection, fresh-session recovery and saved
transaction evidence. Submission tests check exact bytes, disabled transaction-ID
regeneration, expiry and unsuccessful receipts.

Backend tests cover device-bound relay authentication, account isolation,
immutable messages, concurrent proposals, integer precision and transaction
result lookup. Migration 15 and relay persistence were tested in a fresh local
PostgreSQL database under the race detector.

The three-browser acceptance test uses real device authentication, encrypted
Raccoon shares, native enrollment, policy confirmation and signatures. Its
Mirror Node and HAPI responses are simulated locally. It is not proof of a real
Hedera Testnet transaction or of consensus execution. Final observed suite
results are recorded at the completion checkpoint below.

## Limits and next milestone

This is native HBAR Testnet functionality. Native ECDSA signatures remain
conventional; Raccoon is an additional off-chain approval layer. We did not add
distributed key generation, native ECDSA MPC, HTS tokens, NFTs, staking or
scheduled transactions.

The signing window is approximately 117 seconds, so selected signers must be
online together. Keep membership fixed while testing funds. On-chain key
rotation, complete archived-policy access and restored-device authorization
require further work. The account-key rotation proposal in ADR 0023 needs review
before changing Adhil's base membership lifecycle.

Public Testnet verification, independent review, user-entered payment memos, performance
evaluation and release hardening remain. No public blockchain transaction was
executed during implementation. The work remains local until publication is
separately requested.

Confirmation now also checks a native memo commitment to the exact reviewed
operation. A successful receipt for a reused transaction ID cannot by itself
mark a different proposal as paid. The commitment covers policy, proposal,
payer, recipient, amount, maximum fee and native transaction ID.

## Completion checkpoint

The following checks passed on 26 November 2026:

| Check | Observed result |
|---|---|
| Workspace automated tests | 523 passed; 26 skipped. Skipped tests are not counted as verified functionality. |
| Workspace type checking | All 12 configured tasks passed. |
| Production frontend build | Passed, including static export and security-header generation. |
| Shared Hedera browser acceptance | Passed with three independent participant profiles, real Raccoon rounds and native signatures, and locally simulated Mirror/HAPI responses. |
| Existing shared-wallet regression | Shared Bitcoin browser flow and EVM execution/confirmation passed using local fixtures and Anvil. |
| Backend checks | All Go tests passed under the race detector; static analysis passed. |
| PostgreSQL persistence | Migration 15 and relay/store tests passed under the race detector in a fresh disposable database. |
| Secret and whitespace checks | No secret findings in changed/new source files; whitespace check passed. |

The browser check also exposed an encoding mismatch in the operation commitment.
It was corrected to use unpadded URL-safe encoding, with an automated regression
assertion for the native memo format and Hedera's 100-byte limit. Receipt tests
reject a successful result whose operation commitment belongs to another payment.

These are local implementation results. No real Hedera Testnet transaction,
mainnet transaction or deployment was performed, and no claim of release-ready
security follows from these checks.

## Subsequent hardening

The approved native group-migration lifecycle, Bitcoin recovery follow-up and
current release gates are recorded in the
[native shared-wallet hardening milestone](2026-11-26-native-wallet-release-hardening.md).
It supersedes the fixed-membership limitation described at the initial Hedera
implementation checkpoint.
