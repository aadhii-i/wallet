/**
 * Trusted-dealer key generation and share provisioning for a shared QD wallet.
 *
 * TRUST MODEL (read this): the dealer device runs QD-Wallet Alg. 1
 * (qd-crypto `dealerKeyGen`). For the duration of `dealShares` it holds every
 * share, hence the master secret, and could keep a copy and sign alone. This
 * is the paper's trusted key generation; it is NOT a DKG and NOT secure
 * against a malicious dealer. What this module does guarantee:
 *   - DealerOutput exists only inside one `dealShares` call; nothing is
 *     persisted, and the plaintext is overwritten (best effort: JavaScript
 *     gives no guarantee that copies made by the engine are erased).
 *   - each share leaves the dealer only inside an HPKE envelope for exactly
 *     one recipient key, bound to the full share context;
 *   - recipients verify the decrypted share against the published fingerprint
 *     and their assigned index and (T, N) before storing it.
 */
import {
  QdParty,
  dealerKeyGen,
  decodeKeyShare,
  encodeKeyShare,
  masterKeyFingerprint,
  signLocally,
  verify,
  type DealerOutput,
  type KeyShare,
} from '@qd/qd-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wipe } from '../encoding';
import {
  ShareProvisioningError,
  assertShareContext,
  openFromSender,
  sealToRecipient,
  type ShareContext,
  type ShareEnvelope,
} from './envelope';

export interface Recipient {
  participantId: string;
  partyIndex: number;
  /** X-Wing public key registered by the participant's own device. */
  publicKey: Uint8Array;
}

export interface DealParams {
  walletId: string;
  keygenId: string;
  threshold: number;
  parties: number;
  membershipVersion: number;
  recipients: Recipient[];
}

export interface DealtEnvelope extends ShareEnvelope {
  participantId: string;
  partyIndex: number;
}

export interface DealResult {
  fingerprint: string;
  envelopes: DealtEnvelope[];
}

/** Active sets of size T that together include every party index, so each share is exercised. */
export function coveringActiveSets(threshold: number, parties: number): number[][] {
  const sets: number[][] = [];
  for (let start = 0; start < parties; start += threshold) {
    const set = new Set<number>();
    for (let k = 0; k < threshold; k++) set.add(((start + k) % parties) + 1);
    sets.push([...set].sort((a, b) => a - b));
  }
  return sets;
}

/**
 * Dealer self-check before anything leaves the device: every share round-trips
 * through the wire encoding, and T-subsets covering all parties produce
 * signatures that verify under the master key's account key 0.
 */
function selfCheck(out: DealerOutput): void {
  try {
    const decoded = out.shares.map((s) => decodeKeyShare(encodeKeyShare(s)));
    const parties = decoded.map((s) => new QdParty(s));
    const first = parties[0];
    if (!first) throw new Error('no shares');
    const { threshold, parties: n } = out.shares[0]!;
    for (const act of coveringActiveSets(threshold, n)) {
      const msg = crypto.getRandomValues(new Uint8Array(32));
      const sid = crypto.getRandomValues(new Uint8Array(32));
      const sig = signLocally(parties, { sid, act, derivationIndex: 0, msg });
      if (!verify(first.publicKey(0), msg, sig)) throw new Error('verify');
    }
  } catch {
    throw new ShareProvisioningError('SELF_CHECK_FAILED', 'Generated key failed its self-check');
  }
}

function wipeShare(k: KeyShare): void {
  k.share.forEach((p) => p.fill(0));
  wipe(...k.seedsOut, ...k.seedsIn);
}

function assertRecipients(p: DealParams): void {
  const idx = p.recipients.map((r) => r.partyIndex).sort((a, b) => a - b);
  const ids = new Set(p.recipients.map((r) => r.participantId));
  if (
    p.recipients.length !== p.parties ||
    ids.size !== p.parties ||
    !idx.every((v, i) => v === i + 1)
  ) {
    throw new ShareProvisioningError('BAD_CONTEXT', 'Recipients must cover party indices 1..N exactly once');
  }
}

export async function dealShares(p: DealParams): Promise<DealResult> {
  assertRecipients(p);
  // Validate every context before generating anything secret.
  const base = { walletId: p.walletId, keygenId: p.keygenId, threshold: p.threshold, parties: p.parties, membershipVersion: p.membershipVersion };
  for (const r of p.recipients) assertShareContext({ ...base, participantId: r.participantId, partyIndex: r.partyIndex, fingerprint: '0'.repeat(64) });

  const out = dealerKeyGen(p.threshold, p.parties);
  try {
    selfCheck(out);
    const fingerprint = bytesToHex(masterKeyFingerprint(out.shares[0]!));
    const envelopes: DealtEnvelope[] = [];
    for (const r of p.recipients) {
      const share = out.shares[r.partyIndex - 1];
      if (!share) throw new ShareProvisioningError('BAD_CONTEXT', 'Unknown party index');
      const plaintext = encodeKeyShare(share);
      try {
        const ctx: ShareContext = { ...base, participantId: r.participantId, partyIndex: r.partyIndex, fingerprint };
        const env = await sealToRecipient(r.publicKey, ctx, plaintext);
        envelopes.push({ participantId: r.participantId, partyIndex: r.partyIndex, ...env });
      } finally {
        wipe(plaintext);
      }
    }
    return { fingerprint, envelopes };
  } finally {
    out.shares.forEach(wipeShare);
    out.master.tFull.forEach((p) => p.fill(0));
    wipe(out.chaincode);
    out.shares.length = 0;
  }
}

/**
 * Opens this participant's envelope and checks that the share is exactly the
 * one promised: assigned index, (T, N), and the published fingerprint.
 * Returns the encoded share (SECRET; caller must encrypt it before storing).
 */
export async function openShareEnvelope(
  recipientPrivateKey: Uint8Array,
  context: ShareContext,
  envelope: ShareEnvelope,
): Promise<Uint8Array> {
  const plaintext = await openFromSender(recipientPrivateKey, context, envelope);
  assertShareMatches(plaintext, context);
  return plaintext;
}

/**
 * Checks that an encoded share is exactly the one `context` describes:
 * assigned index, (T, N) and the master-key fingerprint. Wipes `plaintext`
 * and throws SHARE_MISMATCH otherwise.
 */
export function assertShareMatches(plaintext: Uint8Array, context: ShareContext): void {
  let key: KeyShare;
  try {
    key = decodeKeyShare(plaintext);
  } catch {
    wipe(plaintext);
    throw new ShareProvisioningError('SHARE_MISMATCH', 'Received share is malformed');
  }
  try {
    const ok =
      key.index === context.partyIndex &&
      key.threshold === context.threshold &&
      key.parties === context.parties &&
      bytesToHex(masterKeyFingerprint(key)) === context.fingerprint;
    if (!ok) throw new ShareProvisioningError('SHARE_MISMATCH', 'Received share does not match this key generation');
  } catch (e) {
    wipe(plaintext);
    throw e;
  } finally {
    wipeShare(key);
  }
}
