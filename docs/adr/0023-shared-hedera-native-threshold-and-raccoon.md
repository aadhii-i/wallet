# ADR 0023: Shared Hedera custody with native threshold keys and Raccoon approval

**Date:** 26 November 2026

**Status:** Implemented as a native HBAR Testnet research extension. Release limitations remain.

## Scope and custody decision

We extend the existing shared-account setup with a separate Hedera account.
Its on-chain key is a flat native threshold containing an independently derived
secp256k1 key from each participant. The native threshold is a strict majority
of two to five participants. Each honest QD-Wallet signer also requires a valid
Threshold Raccoon approval before releasing its native signature.

Hedera enforces the conventional native key threshold, not Raccoon. A colluding
native quorum can spend using other software without the Raccoon gate. This
does not make native HBAR transactions quantum-safe or implement threshold
ECDSA MPC. We reuse the existing trusted-dealer Raccoon provisioning and
three-round signing implementation; distributed key generation remains pending.

The Raccoon threshold remains the threshold of the provisioned key and must be
at least two. It can differ from the native majority. This implementation covers
the project's native HBAR account and transaction features. HTS tokens, NFTs,
staking and scheduled transactions are outside this milestone.

## Deterministic keys and account setup

Each key worker derives its own native key in a new project namespace. The
path begins at `m/48'/3030'/0'/1'` and appends eight hardened indexes obtained
from a SHA-256 hash of the wallet, shared account, key generation, membership
version and Testnet context. The hash is split into eight big-endian 32-bit
words, masked to 31 bits. The context hash has a versioned Hedera-specific
domain. This is a custom recovery namespace, not standard wallet compatibility.
Personal Hedera, Ethereum and Bitcoin derivation paths remain unchanged.

Each participant proves possession of its native key over the complete enrollment
context. The policy binds the native keys, participant indexes, both thresholds
and the account's derived Raccoon public key. All participants compare the same
policy safety number and confirm it before shared account setup is offered.

An owner can create a new account using a funded, linked personal Hedera account
as the fee payer. The worker checks the payer's actual public key against its
own personal derivation and signs the exact reviewed creation transaction.
The page never asks for an external payer private key. The new account has the
approved threshold key, zero initial HBAR, no alias, no automatic token
associations and no receiver-signature requirement. Signed creation bytes are
saved before submission. Uncertain delivery is checked using the saved
transaction ID before another creation is permitted on that device.

Alternatively, participants can link an existing account with exactly the
approved native threshold key. Checking one member's public key is insufficient.
The complete protobuf-encoded key is compared with our canonical policy.
Deleted accounts, changed keys and receiver-signature-required accounts are
rejected. Each participant independently verifies and confirms the numeric
account ID. Receive instructions appear after matching account confirmations.

## HBAR proposal and signing workflow

1. Read and verify the account's current native key and integer tinybar balance.
   Reserve the amounts and maximum fees of other pending local proposals.
2. Build a frozen native HBAR transfer, with the shared account paying the fee,
   a specific node and transaction ID, and a bounded maximum fee. The UI calls
   this a fee cap; it is not a live estimate of the final charge.
3. Every signer reviews the sender, recipient, amount, fee cap and expiry.
   The worker rebuilds the sole permitted operation and compares its entire
   frozen body with the supplied bytes. Hidden token transfers, allowances,
   other operations, extra recipients and changed fields cannot pass this check.
4. Each explicitly approving device generates fresh consent randomness.
   Selected signers derive the actual Raccoon session ID from those contributions
   and the proposal context. Each selected worker verifies its own contribution.
5. Run the existing three Raccoon rounds in the key workers. A permanent atomic
   session burn list is shared with the other protocols. Secret round state is
   never backed up or restored; a lost round requires a fresh proposal.
6. Every native signer independently verifies the final Raccoon signature,
   rechecks the account and available balance, and signs through a scoped native
   key callback. Its signature is saved before being returned.
7. Verify distinct enrolled native signatures and assemble the quorum. Save the
   final transaction before returning it. A separate user action submits those
   exact bytes. Transaction-ID regeneration is disabled on the SDK client.
8. Require a `SUCCESS` receipt and an indexed native-memo commitment matching
   the exact reviewed operation before reporting confirmation. A transaction ID
   alone is insufficient: another operation may have reused it. The memo binds
   the policy, proposal, payer, recipient, amount, fee cap and transaction ID. Missing receipts
   and connection errors mean an uncertain outcome, not a proven failed payment.
   History and HashScan links support subsequent verification.

Native transactions use a 120-second validity period, with a small allowance
before proposal creation. The displayed signing window is therefore about
117 seconds. This requires signers to be online together. Slow or interrupted
sessions expire; the implementation does not silently rebuild or resign them.
Scheduled native transactions would require a separate design for longer-lived
approvals and payer handling.

## Relay, balances and recovery

The new public-message relay is separate from Bitcoin's relay. Registered-device
signatures bind messages to the wallet, account, current key generation,
membership version, phase and session. Active membership and the exact joined
device are checked. Phase messages are immutable and identical retries are
idempotent. The coordinator never receives native private keys or Raccoon shares.
Public messages persist in PostgreSQL migration 15 or a separate atomic snapshot
for memory-store deployments. Existing EVM membership and approval semantics
are preserved.

The new account-information endpoint preserves the full threshold key and
returns amounts as decimal strings. The shared history mode also preserves
integer precision and supports pagination. Current key verification gates
balance reads and transfers. Network/provider failures are not displayed as
zero funds. The configured Mirror Node and consensus endpoints remain trusted
network data sources; this wallet is not an independent Hedera consensus client.

Local reservations prevent this device from approving more than its observed
balance can cover. Confirmation or expiry reconciliation requires a fresh enough
balance snapshot. A missing transaction is treated conservatively until a later
snapshot supports reconciliation. Cross-device coordination relies on an honest
intersecting native quorum; it is not a global account lock.

Encrypted recovery files contain this device's own Raccoon share, policy,
account binding, nonce history and saved transaction evidence. They use the
existing Argon2id-derived key and AES-GCM with a separate recovery domain and
fresh IV. Plaintext shares remain inside the worker. Import checks the recovery
phrase's derived native public key, Raccoon public key and participant context.
Saved operations and native signatures are reverified before being offered as
retries. Raccoon consent and secret round state are not revived from a backup.
Fresh per-signer randomness protects future sessions when restoring an older
snapshot; importing a backup also never removes existing session burn records.

A recovery phrase alone cannot recreate a Raccoon share. Keep the encrypted
share backup and its export-time password. This backup does not replace the
existing authorization/device-recovery protocol.

## Membership changes and release work

The project owner approved the coordinated native migration design on
26 November 2026. [ADR 0024](0024-native-shared-wallet-release-hardening.md)
supersedes the earlier fixed-membership restriction. An enrolled native wallet
now rejects immediate roster edits and uses a replacement shared group while
preserving the old roster. Both groups confirm the migration review. Hedera
rotates the complete native threshold key with independent old/new Raccoon
approvals and both native quorums, then verifies the exact indexed operation
and fresh replacement key. Bitcoin migration must also complete before the
replacement's ordinary native spending is enabled.

Private shares remain in participant workers. The coordinator has no recovery
backdoor and cannot replace a missing native quorum. Complete archived-epoch
and lost-device authorization recovery, independent security review, public
Testnet consensus verification and performance evaluation remain release work.
The current HBAR scope does not add token transfers, scheduled signing or a
claim of post-quantum Hedera consensus. Mainnet remains disabled.

## References

- [Hedera: hierarchical native multisignature](https://hedera.com/blog/hierarchical-multi-signature-support-in-hedera/).
- [Official Hiero JavaScript SDK](https://github.com/hiero-ledger/hiero-sdk-js).
- [Official Mirror Node implementation](https://github.com/hiero-ledger/hiero-mirror-node).
- [Existing Bitcoin custody decision](0022-shared-bitcoin-native-multisig-and-raccoon.md).

Hedera’s native hierarchical/threshold-key model is described in its
[technical overview](https://hedera.com/blog/hierarchical-multi-signature-support-in-hedera/).
The implementation pins the existing SDK and protocol package versions.
