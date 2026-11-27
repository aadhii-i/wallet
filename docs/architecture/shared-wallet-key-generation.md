# Shared wallets: Threshold Raccoon key generation and share provisioning

**Status:**
- **Implemented and tested:**
  - trusted-dealer key generation;
  - HPKE share delivery to independent devices;
  - encrypted share storage;
  - wallet key initialization.
- **Next step:** networked signing and on-chain execution — see [shared-wallet-signing-and-execution.md](shared-wallet-signing-and-execution.md).

**Decision record:** [ADR 0018](../adr/0018-shared-wallet-trusted-dealer-keygen-and-hpke-share-delivery.md). The approval layer is described in [shared-wallet-authorization.md](shared-wallet-authorization.md).

## 1. Trust model (read first)

| Party | Sees | Can |
|---|---|---|
| Dealer (owner's device, during one key-worker call) | `msk`, every share, every pairwise seed, the chain code | Sign alone, if it keeps a copy. **Trusted.** |
| Participant device | Only its own share, inside its key worker | Take part in signing when selected |
| Backend | Public X-Wing keys, opaque envelopes (until acknowledged), the master-key fingerprint, device signatures | Delay or block a ceremony. It cannot read a share. It could substitute an encryption key if it could also forge device signatures; comparing the safety number out of band detects that |
| React UI thread | Public values, ciphertexts, fingerprints | Nothing secret: shares never leave the worker |

This is the paper's **trusted key generation (KGen)**, not a DKG. Nobody can verify that the shares lie on one polynomial (no VSS). The dealer's self-check covers that, and it is only as good as the dealer's honesty.

## 2. Flow

```
Owner (dealer)             Backend                         Participant i (each device)
    |-- start ---------------> freeze N, T=⌈N/2⌉, indices (join order), membership v
    |                          status collecting_keys
    |                                                  <--- X-Wing pk_i + P-256 sig (key worker makes pk_i,
    |                                                       keeps sk_i encrypted in qd-shares)
    |                          all N registered → dealing
    |   (everyone shows the same safety number = H(all pk_i))
    |-- dealShares (key worker): dealerKeyGen(T,N); self-check (encode/decode, covering T-sets sign+verify);
    |   fp = SHA3(T,N,seedA,tFull,chaincode); env_i = HPKE-XWing.Seal(pk_i, info=ctx_i, share_i); wipe
    |-- PUT envelope_i (×N) -->
    |-- commit: fp + P-256 sig over H(index:participant:sha256(env_i) …) --> status awaiting_provisioning
    |                                                  <--- GET own envelope only (bound device)
    |                                                       open with sk_i, check index/T/N/fp,
    |                                                       store share encrypted, delete sk_i
    |                                                  <--- ack: P-256 sig over (…, fp, sha256(env_i))
    |                          envelope_i deleted; after the N-th ack, atomically:
    |                          ceremony complete, wallet key active (fp, keygen id)
```

`ctx_i` (the HPKE `info`):

```
QDWallet-ShareEnvelope|v1|walletId|keygenId|participantId|partyIndex|T|N|membershipVersion|fingerprint
```

## 3. Components

| Concern | Where |
|---|---|
| KGen (QD-Wallet Alg. 1), unchanged | `packages/qd-crypto/src/keys.ts` `dealerKeyGen` |
| Share wire format (`QDKS` v1), fingerprint | `packages/qd-crypto/src/encoding.ts` `encodeKeyShare` / `decodeKeyShare` / `masterKeyFingerprint` |
| HPKE envelope, dealer, recipient checks | `packages/wallet-core/src/qd-shares/{envelope,ceremony}.ts` |
| Encrypted share store (separate Argon2id salt) | `packages/wallet-core/src/qd-shares/store.ts` |
| Key worker operations | `apps/web/src/lib/key-worker.ts`: `qdShareUnlock`, `qdShareStatus`, `qdPrepareKeygen`, `qdDeal`, `qdAcceptShare` |
| Signed messages, safety number, client checks | `packages/rpc/src/shared-keygen.ts`, `ApiClient` key-generation methods |
| Ceremony rules, routes | `services/wallet-api/internal/sharedwallet/keygen*.go` |
| Persistence | `internal/store/{memory,postgres}/shared_keygen.go`, migration `00009_shared_key_generation.sql` |
| UI | the "Threshold key" card in `apps/web/src/features/shared/shared-wallets.tsx` |

## 4. Statuses

| Wallet `key.status` | Meaning |
|---|---|
| `not_initialized` | No ceremony yet |
| `in_progress` | Ceremony collecting encryption keys or waiting for the dealer |
| `awaiting_provisioning` | Envelopes committed; some participants have not acknowledged |
| `initialized` | All N acknowledged the same fingerprint: the key is active |
| `failed` | Last ceremony cancelled, expired (24 h), failed to decrypt or verify, or invalidated by a membership change |
| `rekey_required` | The key was initialized, then membership changed: a new ceremony is needed |

Approved proposals can be signed only when the active key's membership version and T equal the proposal's snapshot; otherwise their lifecycle is `awaiting_key_generation`.

## 5. Failure and recovery

- **Partial provisioning.** The wallet stays uninitialized. Once the ceremony expires or fails, all envelopes are deleted and the owner starts a new one: a new key and new shares. A participant whose acknowledgement was lost retries; its stored share is detected and only the acknowledgement is resent.
- **Decryption or verification failure.** The participant's client reports `decryption_failed` or `share_verification_failed`, which fails the ceremony.
- **Duplicates.** A repeated key registration, envelope fetch or acknowledgement is refused (`ALREADY_REGISTERED`, `ALREADY_PROVISIONED`). Envelopes are frozen once committed, and envelopes from different dealer runs (different fingerprints) cannot be committed together.
- **Membership change.** A change during a ceremony fails it (`membership_changed`). A change after initialization marks the key `rekey_required`; the new ceremony excludes revoked participants.
- **Lost device or wiped wallet.** The BIP-39 phrase does not recover a share. Without its backup file (§5.1) the share is gone and a new ceremony is required.

### 5.1 Share backup files

Each participant's device keeps a backup **file** of its own share. Implementation: `packages/wallet-core/src/qd-shares/backup.ts`, key-worker ops `qdAutoShareBackup`, `qdExportShareBackup` and `qdRestoreShareBackup`.

- **Automatic.** Right after "Receive my share" stores the share, the device downloads `<wallet name> <YYYY-MM-DD>.json` (local date; characters not allowed in file names are removed). The file opens with the **wallet password**: its key is HKDF-SHA256 of the share store's Argon2id key, and the file carries the store's KDF header. No extra prompt is needed, and the file is exactly as hard to guess as the share store this origin already keeps in IndexedDB. After a wallet-password change, an older file still opens with the old password.
- **On request.** "Back up my share" on the Threshold key card makes another copy under a separate backup password, with the same file name.
- **Contents.** JSON with the file kind (`wallet-password` or `backup-password`), the public share context (wallet, key generation, participant, party index, T, N, membership version, fingerprint), the KDF header and the ciphertext. Never the plaintext share, never another participant's share.
- **Encryption.** Argon2id with the wallet's parameters (64 MiB, 2 passes), then AES-256-GCM. The AAD binds the format version, the file kind, the whole context and the KDF header, so an edited or relabelled file fails to decrypt and the KDF cannot be downgraded. A separate backup password must pass the wallet's strength check and differ from the wallet password.
- **Export on request** asks for the wallet password again, as revealing the recovery phrase does.
- **Restore** is offered only to a participant of the wallet's current key whose device holds no share. The worker refuses a file for another wallet, an earlier key or another participant (`BACKUP_WRONG_KEY`), then checks the decrypted share's index, T, N and fingerprint (`SHARE_MISMATCH`) before storing it.
- **Threshold.** One stolen file plus its password yields one share, not T.
- **Limits.**
  - A file is valid only until the key is regenerated; after a rekey, back up again.
  - Participants are bound to the browser's device key (`qd-device`), and the server treats a new device key as a new user. Restore therefore works only where this participant's device key still exists, i.e. when the share store alone was lost. "Remove wallet" and "Restore with recovery phrase" also delete the device key (`forgetDevice`), and a new device has a new one. For those cases the participant must first be **re-linked to the new device key**, which does not exist yet; until then the file is kept safe but cannot be restored there.


## 6. Manual test (5 browsers)

This continues step 7 of [shared-wallet-authorization.md §7](shared-wallet-authorization.md#7-local-multi-user-testing):
1. **Everyone:** the "Threshold key" card shows *Status: Not initialized*.
2. **P1:** click *Start key generation*. Every card shows *Key generation in progress* with parties #1–#5.
3. **Each participant:** enter the wallet password, click *Unlock key-share storage*, then *Prepare this device*. Once all five are ready, every card shows the same *Safety number*; compare them.
4. **P1:** click *Generate and distribute shares*. The status becomes *Awaiting participant provisioning*.
5. **Each participant:** click *Receive my share*. The status stays *Awaiting…* until the fifth, then becomes *Key initialized*. Each card says *This device holds share #i* and shows the same key fingerprint.
6. **The approved proposal** now shows its selected signers; signing starts once the account's smart-account address is derived (see the signing doc §5).
7. **Revoke a participant.** The status becomes *Membership changed — new key generation required*.

Automated checks:
- `make e2e-shared` drives exactly this flow in five browser contexts.
- `shared-keygen.integration.test.ts` (in `packages/rpc`) runs it over HTTP with real cryptography and signs the approved digest in-process with the delivered shares.
