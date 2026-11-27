# ADR 0018: Shared-wallet key generation by a trusted dealer, with HPKE X-Wing share delivery

- **Status:** Accepted for research and testnet use only. Not audited.
- **Builds on:** [ADR 0014](0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md) (protocol), [ADR 0017](0017-shared-wallet-approval-policy-separate-from-raccoon-threshold.md) (approval policy), the Phase 3.2 design decisions.
- **Date:** 2026-11-14

## Context

A shared wallet's approval policy (ADR 0017) needs a matching T-of-N Threshold Raccoon key: T = ⌈N/2⌉ of the active participants at the time of key generation. `packages/qd-crypto` already implemented the paper's KGen (QD-Wallet Alg. 1, `dealerKeyGen`): a trusted dealer samples `msk`, publishes `(seedA, tFull = A·msk + e)`, Shamir-shares `msk` with a random degree-(T−1) polynomial, and draws the N×N pairwise seeds and the chain code. What was missing:

- a wire format for a key share;
- a way to get each share to its participant's device without the backend or anyone else seeing it;
- encrypted local storage of the share;
- a ceremony that only declares the wallet key initialized once every participant holds a verified share.

There is no DKG for Threshold Raccoon in this codebase (or in the paper), so the dealer is unavoidable for now.

## Decision

1. **The dealer is the owner's device.** It runs `dealerKeyGen(T, N)` once, inside one key-worker call (`dealShares`). Before anything leaves the device, it runs a self-check:
   - every share round-trips through the wire encoding;
   - T-subsets covering all N parties sign and verify in-process.

   It then seals each share to its recipient and returns only ciphertexts and the fingerprint. `DealerOutput` is never persisted; its buffers are overwritten afterwards on a best-effort basis (JavaScript cannot guarantee erasure).
2. **Envelope = HPKE base mode** (RFC 9180):
   - KEM: X-Wing (X25519 + ML-KEM-768, id `0x647a`)
   - KDF: HKDF-SHA256
   - AEAD: AES-256-GCM

   It comes from `@hpke/core` + `@hpke/hybridkem-x-wing` 0.7.1. No construction of our own. A test cross-checks hpke-js X-Wing against `@noble/post-quantum`'s independent `ml_kem768_x25519`: shared secrets agree in both directions and the 32-byte seed key format is the same.

   The HPKE `info` binds the envelope to the wallet id, keygen id, participant id, party index, T, N, membership version and master-key fingerprint.
3. **Recipient keys are per ceremony.** Each participant's key worker generates a fresh X-Wing key pair and stores the private key encrypted. The device registers the public key with a P-256 device signature over `QDWallet-KeygenKey|v1|wallet|keygen|participant|index|membershipVersion|sha256(pk)`. Every client shows a **safety number** derived from all registered keys. Participants who compare it out of band detect a server that substituted a key.
4. **Fingerprint:**

   ```
   SHA3-256("QD-master-fingerprint-v1" ‖ T ‖ N ‖ seedA ‖ tFull ‖ chaincode)
   ```

   It is the only master-key value the backend stores. `tFull` and the chain code stay confidential (ADR 0014 keeps them unpublished).
5. **Recipient verification.** A participant accepts a share only if it meets all of these:
   - the envelope opens under its own key and the exact context;
   - the decoded share has the assigned index and (T, N);
   - the share's own `(seedA, tFull, chaincode)` hash to the published fingerprint;
   - its seed matrix is self-consistent.

   It then stores the share encrypted, deletes the receiving key, and acknowledges with a device signature over the fingerprint and `SHA-256(enc‖ct)`.
6. **At rest:** `QdShareStore` encrypts with AES-256-GCM under Argon2id(wallet password, a salt separate from the vault's). The metadata is the AAD. The whole store is one IndexedDB value, so a password change re-encrypts it atomically. The vault format is unchanged.
7. **Backend role: coordinator and mailbox only.** It stores public keys, opaque envelopes and the fingerprint. Each participant can fetch only its own envelope, from the device bound to its membership. Envelopes are deleted on acknowledgement and when a ceremony fails. The wallet key becomes `active` only in the same atomic step that records the last of the N acknowledgements.
8. **Lifecycle:**
   - At most one open ceremony per wallet.
   - Owner-only start; only the dealer can stage or commit envelopes.
   - TTL 24 h.
   - Any party may report a decryption or verification failure; the dealer may cancel.
   - Any join or revocation fails the open ceremony.
   - After completion, a membership change marks the key `rekey_required`, and a new ceremony is needed: there is no resharing.
   - A proposal's signing job counts as "awaiting signing session" only if the active key's membership version and T equal the proposal's snapshot.
9. **Party indices** follow join order (the owner is 1). A signing job's signers map to their party indices, which become the future session's `act`.

## Consequences

- **Trusted dealer.** The dealer device (and anyone who controls it during the ceremony) learns `msk` and could sign alone. This is the paper's trusted key generation. It is **not** a DKG and is not secure against a malicious dealer.
- **Share consistency.** No participant can check that the shares lie on one polynomial: there is no VSS for this scheme here. That rests on the dealer's honesty and self-check.
- **Classical authentication.** Encryption keys and acknowledgements are authenticated with classical P-256 device keys. A server that can also forge device signatures could substitute keys, and only the out-of-band safety-number comparison detects that.
- **T = 1.** When ⌈N/2⌉ = 1 (N ≤ 2), every share equals `msk`. That matches a 1-of-N policy, but each participant can sign alone.
- **Recovery.** The BIP-39 phrase does not recover a QD share. Wiping the wallet or losing the device loses the share unless the participant made a share backup file (added later; see shared-wallet-key-generation.md §5.1). Otherwise the only remedy is a new ceremony (and a new key).
- **Not done here.** Signing is not implemented across devices, and there is no on-chain verifier. An initialized key changes the proposal status to `awaiting_signing_session`, never to signed.
- **Payload size.** A share is about 33 KB (3-of-5) to 36 KB (N = 64). Envelopes are uploaded one per request to stay under the 64 KB body limit.
