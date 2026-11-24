# Proposal: Threshold Raccoon approvals for Bitcoin payments

**Status: The project owner approved Bitcoin-native multisignature plus Raccoon
approvals. A Testnet4 research implementation now exists; see
[ADR 0022](../adr/0022-shared-bitcoin-native-multisig-and-raccoon.md) and the
[implementation record](../changes/2026-11-24-shared-bitcoin-raccoon.md).
The alternatives below record the original design discussion, rather than
additional implemented custody models.**

## Objective and security boundary

Allow the shared-wallet participants to authorize a fully specified Bitcoin
payment using Threshold Raccoon before conventional Bitcoin signing. Preserve
Adhil's current EVM shared-wallet protocol and behavior. Add a separate Bitcoin
execution model only after approval; do not disguise a Bitcoin transaction as an
EVM proposal or reuse an EVM account's signing message.

Bitcoin's supported P2WPKH and key-path P2TR outputs accept conventional ECDSA
and Schnorr signatures, respectively. They cannot verify a Threshold Raccoon
signature under current consensus rules. This proposal therefore cannot make
the native Bitcoin transaction post-quantum secure. A Raccoon signature is
off-chain approval evidence, not the witness that the Bitcoin network enforces.

## The custody decision must come first

| Model | What it enforces | Remaining bypass |
|---|---|---|
| Raccoon gate before our existing single-key worker | This wallet's honest software waits for Raccoon approval | The seed/private-key holder can use other software and spend without that approval. A compromised signer can bypass the gate. |
| Bitcoin-native multisignature plus a Raccoon gate at each signer | Bitcoin enforces a conventional signing quorum; honest signers also require Raccoon evidence | A colluding conventional quorum can bypass Raccoon. Native signatures remain vulnerable to sufficiently capable quantum attacks. |
| Reviewed conventional threshold/MPC signing plus a Raccoon gate | Avoids one complete Bitcoin key on an individual signer, if the protocol and setup achieve that property | The conventional threshold protocol introduces substantial separate assumptions and still produces a quantum-vulnerable native signature. |

Recommendation: treat the single-key gate as a clearly labeled research
demonstration only. For a release advertised as a shared Bitcoin wallet, first
review a Bitcoin-native threshold custody model. Native multisignature requires
new output scripts, addresses, recovery descriptors and funding/migration plans;
our current single-key SegWit/Taproot addresses cannot silently become multisig.
Do not move funds or change address types as part of approving this document.

## Proposed authorization flow

1. **Enroll policy.** Bind the Bitcoin account, network/genesis identifier,
   native custody configuration, Raccoon key fingerprint, participant membership
   version, approval policy, and signing threshold. Each participant verifies
   this binding independently and persists its accepted policy. The existing
   distinction between proposal approval count and Raccoon signing threshold
   remains intact.
2. **Build the Bitcoin proposal.** Freeze the unsigned transaction and all input
   outpoints, previous-output evidence, recipient outputs, owned change outputs
   and paths, fee and fee-rate limits, sequences, locktime, and allowed signature
   modes. Every participant can display the same payment and independently
   verify ownership/change and previous outputs.
3. **Define a Bitcoin-specific commitment.** Use a reviewed canonical encoding
   and domain separation, such as `QDWallet-BitcoinApproval/v1`. Include network
   and genesis, wallet/account and policy identity, membership/key version,
   proposal identifier, expiry, and hashes of the canonical transaction and
   previous-output evidence. Never approve mutable JSON or a display-only amount.
4. **Approve and run Raccoon.** After the required approvals, selected signers
   derive the appropriate Raccoon account shares and run the existing three-round
   mechanism in a fresh signing session. Review the Bitcoin derivation context
   before reusing the cryptographic implementation. Keep protocol session
   identifiers unique and bind every round to the exact Bitcoin proposal.
5. **Verify at every native signer.** Each native signer verifies the Raccoon
   signature against its pinned policy and the locally recomputed commitment.
   A coordinator's boolean success flag is insufficient. Then recheck native
   transaction details, current coins, expiry, and input reservations before
   releasing any conventional signature.
6. **Finalize and submit.** Persist the fully signed native transaction before
   returning it. Broadcast exactly those bytes, check the transaction ID, track
   confirmations, and retain the Raccoon authorization evidence for audit.

## Mutations, retries and recovery

A changed recipient, amount, input set, fee, change path, sequence, locktime, or
network invalidates the approval and signature. A replacement/fee-bump transaction
needs a new approval unless a separate, tightly bounded replacement policy is
reviewed and approved. Re-broadcasting identical signed bytes is not a new payment.

Interrupted Raccoon rounds follow the existing fresh-session retry rules. Never
resume by reusing secret signing masks. Native-signature collection must not
permit execution with a mismatched policy version or expired authorization.
Revocation and recovery of Raccoon shares do not automatically rotate or recover
Bitcoin's native spending keys. Both custody layers need explicit recovery and
membership-change policies, including movement of funds when required.

## Acceptance criteria before implementation/release

- Owner approval of the custody model, proposal format, policy binding, and
  recovery/rotation model; review of changes affecting Adhil's architecture.
- Cross-language commitment vectors and replay/mutation/expiry tests.
- Invalid shares, unavailable participants, stale membership, tampered
  coordinator transcripts, and interrupted-session tests.
- Native signer refusal when approval evidence is missing, invalid, stale,
  for another network, or for different transaction bytes.
- Regtest execution and failure scenarios; public Testnet4 tests only with
  explicit authorization.
- A bypass demonstration for the single-key prototype, rather than a false
  claim that its policy is enforced by Bitcoin.
- Independent cryptographic, contract/protocol, recovery, and implementation
  review before release claims.

References: [existing networked signing](shared-wallet-signing-and-execution.md),
[existing provisioning](shared-wallet-key-generation.md),
[BIP 141](https://bips.dev/141/), [BIP 143](https://bips.dev/143/),
[BIP 341](https://bips.dev/341/), [BIP 174](https://bips.dev/174/).
