# ADR 0024: Release hardening for native shared wallets

**Date:** 26 November 2026

**Status:** Recovery and signing hardening authorized. Membership migration design approved by the project owner. Public-chain verification and independent review pending.

## Objective and release boundary

We are developing usable native HBAR and Bitcoin wallets with Raccoon approvals.
Changing a preview label does not establish production security. Mainnet remains
disabled for shared native accounts until recovery, membership transitions,
public Testnet verification and independent review have evidence. Native ECDSA
remains conventional and can be used by a colluding native quorum outside this
application. Raccoon approval is enforced by our signer, not by either chain.
The existing trusted-dealer provisioning model is unchanged.

## Authorized hardening

Bitcoin needs an encrypted portable backup containing this participant's share,
the public policy, derivation context, change cursor and signed-payment evidence.
Import must verify the recovery phrase, native public root, share index, Raccoon
public key, immutable proposal and all saved signatures. Import must never reset
the change cursor or revive Raccoon consent or secret round state. Already signed
inputs remain reserved even when a proposal expires: Bitcoin signatures have no
software-enforced expiry. Saved transactions may only be resubmitted byte for
byte after a fresh network and input check. Missing transactions do not establish
that an input can safely be reused.

New Bitcoin approvals use a versioned message and fresh randomness from every
selected Raccoon signer. The actual signing session identifier commits to all
these contributions. Each worker checks its own contribution. This prevents a
stale backup from recreating a previous mask session if a coordinator repeats its
proposal identifier. Existing native keys, policies and receive addresses remain
unchanged. Legacy signing sessions require a new proposal; existing saved native
transactions retain a read-only recovery path.

Both chains need bounded signing-session memory, current network data before
new signatures, explicit delivery status and recovery screens. A backup is not
chain evidence: imported payment statuses must be reconciled before reservations
can be released. Honest UI copy must explain native quorum, backup requirements,
Testnet scope and pending verification without claiming post-quantum consensus.

## Approved membership transition

Adhil's current membership lifecycle activates a roster change immediately.
Native keys are not revoked by that database change. The project owner approved the migration design on 26 November 2026.

The approved transition is:

1. Create a pending roster, without removing old members' signing access. New
   members enroll their native keys and provision the next Raccoon policy.
2. Freeze new spending proposals during migration and reconcile all existing
   signed operations. Keep the old roster and its policy recoverable.
3. With explicit old-roster Raccoon approval and the old native quorum, migrate
   Bitcoin UTXOs to the approved new script and submit a Hedera account-key update.
   Every participant reviews both destination policies. No owner-only override.
4. Verify chain results and destination keys. Activate the pending roster only
   after every registered native account is migrated. Otherwise retain a visible
   pending/partial state with old access; never silently roll back an on-chain
   migration or pretend the two chains changed atomically.
5. Preserve old policy recovery and monitoring. Bitcoin funds sent to old scripts
   later still belong to the old quorum; native signatures already released
   cannot be invalidated by changing the application's roster.

This needs persistent migration records, authenticated old-epoch relay access,
recovery after partial completion and separate adversarial tests. Without approval
we retain the base lifecycle and explicitly treat coordinated membership changes
as a release blocker.

## Evidence required before public release

| Area | Required evidence |
|---|---|
| Native consensus | Explicitly authorized real Testnet account creation, funding, receipt/confirmation and spending, including change spending for Bitcoin. |
| Recovery | Lost browser storage, restored share backup, wrong phrase/password, stale backup, interrupted signing and uncertain submission. |
| Membership | Authorized migration implementation and tests for partial completion, revoked devices and late funds to old Bitcoin scripts. |
| Cryptography | Independent review of Raccoon, trusted-dealer provisioning, device authentication, local encryption and native signing boundaries. |
| Operations | Provider outages, stale responses, storage exhaustion, browser concurrency, deployment configuration, monitoring and incident procedures. |
| Performance | Measured end-to-end signing time, failure rate, bandwidth, memory and storage growth on supported browsers/devices. |

## Implemented transition and recovery semantics

The pending roster is represented by a replacement shared wallet. This reuses
Adhil's existing invitation, provisioning, account and participant design. A
healthy active old member who owns the replacement may prepare the migration;
control of the old owner's device is not an override or a requirement. Both
current rosters remain intact. The replacement's native spending is paused once
both groups freeze the review, and resumes only after verification. EVM accounts
and assets stay in their original group and need their existing EVM approval flow
if they are to move. No database membership edit pretends to revoke a native key.

Authenticated enrollment transcripts reconstruct every registered native policy.
Each participant's native possession proof, party index, derivation context,
Raccoon group key, policy confirmation and Hedera account binding is checked.
The migration review binds both rosters, both policies, every destination,
Bitcoin coin nominations and per-operation fee caps. Both groups confirm the
same digest with their registered devices. The browser rebuilds that digest,
validates the native policies and verifies the device confirmations independently.

For Bitcoin the reviewed snapshot names exact funding transaction outputs,
values and derivation paths. Confirmation requires a registered sweep covering
every currently nominated output with six confirmations. An empty address view,
pending spend or one successful batch does not establish completion. Batches
spend at most 100 inputs to one approved replacement script with no change.
Other coins, omitted dust and late deposits still belong to the old quorum;
completion never claims that every possible old address has been emptied.
The old policy, shares, signed-payment evidence and reservations remain available.
A migration may explicitly conflict with an older signed payment, whose signatures
cannot be revoked. The signer retains both operations' evidence. Users must
reconcile which one confirms and revise the nominated snapshot if necessary.

A Hedera account-key update requires both the old and the new native key
quorums. Each group also produces its own Raccoon approval over the same frozen
transaction body under its own signing context. Single-group finalization is
rejected. The coordinator parses the public frozen bytes and rejects hidden
account changes. Completion requires the matching successful native memo
commitment and the entire new threshold key in a fresh account snapshot.

Migration records persist in PostgreSQL or atomic public snapshots. Revision
checks reject stale updates. While frozen or partial, relays accept only
registered migration sessions for the planned native accounts. The coordinator
has read-only blockchain clients; it cannot sign, submit, regenerate transaction
identifiers or roll back chain state. Public registered proposals remain separate
from actual device-authenticated relay messages.

A pending migration may receive a revised coin snapshot and fee budget. It
cannot change participants, native policies or destinations. The previous
manifest and approvals remain in history, both groups must confirm again, and
ordinary native spending stays paused. Earlier signed transactions remain valid
under their earlier authorization; a software amendment cannot revoke them.
A completed migration is a historical checkpoint. Later provider failure or a
reorganization raises a monitoring warning rather than silently disabling the
replacement group. Recovery still requires checking chain state.

## Remaining release gates

The implemented lifecycle has local engine, worker, coordinator and persistence
evidence. It is not release certification. Public Testnet consensus verification,
a complete two-group browser migration journey, old-epoch authorization recovery,
restoring authorization after loss of every registered device, independent
security review and measured browser/provider failure performance remain gates.
Hedera's current signing window is short and its frozen transaction uses one
node; node outages require safe reconciliation and a fresh explicitly reviewed
attempt. This work does not introduce native MPC, DKG, post-quantum Bitcoin
consensus or post-quantum Hedera consensus.

## References

- [Bitcoin output descriptors](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md).
- [BIP 380 descriptor checksum specification](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki).
- [Hedera transaction identifiers](https://docs.hedera.com/native/transactions/transaction-id).
- [Bitcoin custody](0022-shared-bitcoin-native-multisig-and-raccoon.md) and
  [Hedera custody](0023-shared-hedera-native-threshold-and-raccoon.md).
