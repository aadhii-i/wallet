# ADR 0017: Shared-wallet approvals are a policy layer, separate from the Threshold Raccoon key

- **Status:** Accepted for research and testnet use only. Not audited.
- **Spec:** §15. Builds on [ADR 0014](0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md).
- **Date:** 2026-11-13

## Context

A shared QD wallet must require approval from at least half of its active participants before a transaction is authorized. Participants are independent users, each authenticated by their own device key (ADR 0008). The Threshold Raccoon implementation in `packages/qd-crypto` was checked for compatibility:

| Question | Finding |
|---|---|
| Arbitrary T-of-N | `dealerKeyGen` accepts 1 ≤ T ≤ N ≤ 64. Every T = ⌈N/2⌉ from N = 1 to 64 signs and verifies in-process (1/1 … 32/64 measured). 50-of-100 is refused. |
| Signer set | Exactly T signers (ADR 0014 §7); more than T is refused. Any T-subset works. |
| T = 1 | Accepted, but every share equals the master secret (degree-0 polynomial). That matches a 1-of-N policy. |
| Membership change | Shares from different `dealerKeyGen` runs cannot sign together. No refresh, resharing or threshold change exists, so every join or revocation needs a new key. |
| Key generation | Trusted dealer only; the dealer sees the master secret and could sign alone. No DKG. |
| Execution | No on-chain Raccoon verifier or smart account exists, so a Raccoon signature cannot move funds. |

## Decision

1. **Approvals are coordination, not cryptography.** The backend (`internal/authorization`, `internal/sharedwallet`) evaluates signed approvals against a versioned policy snapshot. Reaching the threshold creates one signing job; it never produces or stands in for a Raccoon signature.
2. **Policy** is a versioned ratio (initially 1/2, ceil rounding). Each proposal freezes the policy, membership version, participant count, required approvals and the eligible participant ids. A rejection is a negative vote; a proposal is rejected only when the threshold becomes unreachable.
3. **Participants ≠ accounts.** Shared wallets have their own tables. Creating an account (a QD derivation index) never adds a participant, and vice versa. HD wallets and ECDSA signing are untouched.
4. **Votes** are signed by the participant's device key (P-256, IEEE P1363) over a message binding decision, proposal digest, wallet, policy and membership versions, participant, a single-use server nonce and a timestamp. The client recomputes the SHA-256 proposal digest from the displayed fields and refuses to sign on mismatch.
5. **Atomicity.** Nonce claim, eligibility, one-vote-per-participant, recount, status transition and signing-job creation happen in one store operation (Postgres: one transaction with a fixed lock order wallet → proposal → member; memory: one mutex).
6. **Membership changes** bump `membershipVersion`, supersede pending and approved-but-unsigned proposals (their snapshots are kept), and mark an active key `rekey_required`. Nothing claims a key changed because a database threshold changed.
7. **Cap at 64 active participants** so every allowed policy snapshot can be backed by a Raccoon key.
8. **Signing set:** the first T approvers in vote order. When signing is implemented, their party indices form `act`.

## Consequences

- Signing jobs stay `awaiting_key_generation` until the share-distribution ceremony (Phase 3.2 design) and a networked signing session exist.
- Approval authenticity is classical (P-256), not post-quantum.
- With a trusted dealer, the cryptographic threshold is only as strong as the dealer's honesty; the UI must say so.
- Rejoining after revocation creates a new participant id; the old record stays for audit.
- Policy changes other than 1/2 are not exposed yet (no PUT endpoint).
