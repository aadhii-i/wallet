# ADR 0022: Shared Bitcoin multisignature with Threshold Raccoon approval

**Status:** Approved by the project owner; implemented as a Testnet4 research preview.
**Date:** 2026-11-24.

## Decision and security boundary

We add a separate Bitcoin account beneath an existing initialized shared account.
Bitcoin enforces a conventional P2WSH multisignature script. Each participating
QD-Wallet signer additionally requires a verified Threshold Raccoon signature
over the exact Bitcoin proposal before releasing its native signature.

These are different guarantees. Bitcoin does not verify Raccoon. A conventional
signing quorum using other software can bypass the approval gate. Native ECDSA
signatures remain vulnerable to a sufficiently capable quantum computer. This
implementation is neither post-quantum Bitcoin consensus nor threshold ECDSA MPC.

Personal Bitcoin SegWit/Taproot addresses and existing EVM contracts, derivation,
provisioning, approval policy and signing messages retain their existing behavior.
Existing funds are not migrated. The shared Bitcoin account needs separate funding.

## Enrollment and deterministic native keys

Each participant derives its own native account root inside its key worker.
The custom path starts at `m/48'/coin'/0'/2'` followed by eight hardened indexes
formed from a SHA-256 hash of the wallet/account/key-generation/membership/network
context. It is a versioned project namespace, not a claim of standard BIP48 wallet
recovery compatibility. Public roots are Testnet extended public keys; branch 0
holds the receive key and branch 1 holds fresh change keys. This preview exposes
receive index 0, with change indexes 0–9999 and gap discovery of 20 addresses.

Each device proves possession of its native key over the enrollment context.
Public roots, participant indexes, the existing derived Raccoon public key and
both thresholds form a canonical policy fingerprint. Every participant must
compare that safety number independently and pin the policy. Funding instructions
appear only after all participants have published matching confirmations.
The coordinator cannot substitute a key unnoticed if this comparison is performed.

Native keys are sorted for each output. The native threshold is a strict majority
of 2–5 members; the Raccoon threshold is the existing provisioned key threshold,
which must be at least two. Those thresholds can differ. The UI currently selects
the first Raccoon threshold number of party indexes; alternate signer selection
needs a later UI extension. A typical supported setup is 2-of-3 for both layers.

## Proposal, authorization and signing

The proposer checks the configured upstream's Testnet4 genesis, discovers funds,
hydrates confirmed inputs with raw previous transactions, checks owned scripts,
and builds an immutable PSBT with conservative fees and fresh shared change.
The proposal commits to the policy and network, fresh session and proposal IDs,
expiry, exact PSBT, input paths, recipient, amount, fee and change path.

Each device explicitly approves that commitment. Selected devices exchange the
existing three Raccoon rounds using a Bitcoin-specific message domain. Every
native signer locally verifies the resulting Raccoon signature and PSBT, and
the UI rechecks current unspent inputs before requesting a signature. Native
keys never enter the coordinator or frontend page.

The worker reserves inputs and change and saves its native partial in one
IndexedDB transaction before returning it. Finalization verifies each native
signature against the reviewed transaction and reconstructs the final PSBT from
reviewed metadata and verified signature tuples only. Duplicate signatures do
not satisfy the native quorum. Final bytes are saved before being returned.
Submission requires a separate explicit user action and checks the returned ID.

## Relay, storage and nonce safety

The new relay carries public enrollment, approval, round and partial-signature
messages. It authenticates active membership, the exact registered device,
account and key generation. Device signatures bind every message to that context.
Each author's message for a phase/session is immutable; identical retries are
idempotent. A session has one proposal. Storage uses PostgreSQL migration 14 or
an atomic public-message snapshot in memory-store deployments. Limits apply to
message and room size. The relay neither owns keys nor verifies Raccoon success;
the signing workers perform that verification.

The shared worker's signing-session burn list is now atomic across tabs and is
never pruned. Its bounded capacity fails closed. This also closes the existing
EVM worker's check/write race and old-session pruning window, without changing
its cryptographic protocol. Public outgoing Bitcoin rounds can be retransmitted;
secret round state remains in memory. Lost secret state requires a fresh proposal
and session. No signing masks are persisted or reused. Stateless child-key derivation does
not remove the need for durable nonce history, input reservations and recovery
metadata in a practical wallet.

The existing Argon2id/AES-GCM share store retains an encrypted copy of this
device's pinned-policy Raccoon share, using policy-specific authenticated metadata.
Replacing the current EVM share cannot overwrite that archived copy; password
rotation also re-encrypts it. A recovery phrase alone cannot recreate Raccoon
shares or the other members' public policy data.

## Release limitations

This is a research preview with mainnet disabled. The trusted-dealer Raccoon
provisioning model remains unchanged. Full descriptor/policy export, encrypted
share backup/import, archived-policy recovery screens, signer substitution,
and coordinated recovery after membership changes are not complete. Changing
membership must not be treated as revoking a Bitcoin key: funds must be moved
under the old native policy. Keep membership fixed during current testing.

Reservations are conservative and do not automatically release abandoned signed
proposals; safely replacing one requires explicit reconciliation. There is no
RBF/CPFP interface. UI retry after expiry and interrupted native signing needs
further recovery work. Software expiry cannot invalidate native signatures
already released. Upstream genesis/raw-transaction checks do not independently
prove confirmations or unspentness against a malicious provider.

Before release: complete recovery and migrations, review multi-device conflicts
and replay behavior independently, test adversarial coordinators and members,
verify real Testnet4 journeys with explicit authorization, and measure signing
latency, bandwidth, browser resource use and storage growth. No production
security certification or public-testnet transaction is claimed by this ADR.
