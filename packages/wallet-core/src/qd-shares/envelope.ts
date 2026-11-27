/**
 * Share envelopes: HPKE (RFC 9180, base mode) with the X-Wing hybrid KEM
 * (X25519 + ML-KEM-768, KEM id 0x647a), HKDF-SHA256 and AES-256-GCM, from
 * hpke-js. No construction of our own: the library implements both the KEM
 * and the key schedule, and test/qd-shares.test.ts cross-checks its X-Wing
 * against @noble/post-quantum's independent implementation.
 *
 * The HPKE `info` binds the ciphertext to the wallet, key generation,
 * participant, party index, (T, N), membership version and master-key
 * fingerprint, so an envelope cannot be replayed into another context.
 */
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { XWing } from '@hpke/hybridkem-x-wing';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { utf8ToBytes } from '../encoding';

export const XWING_PUBLIC_KEY_BYTES = 1216;
export const XWING_PRIVATE_KEY_BYTES = 32;
export const XWING_ENC_BYTES = 1120;

export class ShareProvisioningError extends Error {
  constructor(
    readonly code:
      | 'BAD_CONTEXT'
      | 'BAD_KEY'
      | 'DECRYPTION_FAILED'
      | 'SHARE_MISMATCH'
      | 'SELF_CHECK_FAILED'
      | 'STORE_LOCKED'
      | 'STORE_CORRUPT'
      | 'NOT_FOUND'
      | 'BACKUP_INVALID'
      | 'BACKUP_WRONG_PASSWORD'
      | 'BACKUP_WRONG_KEY',
    message: string,
  ) {
    super(message);
    this.name = 'ShareProvisioningError';
  }
}

/** Everything a share is bound to. All fields are public. */
export interface ShareContext {
  walletId: string;
  keygenId: string;
  participantId: string;
  partyIndex: number;
  threshold: number;
  parties: number;
  membershipVersion: number;
  /** Hex SHA3-256 master-key fingerprint (qd-crypto masterKeyFingerprint). */
  fingerprint: string;
}

export interface ShareEnvelope {
  enc: Uint8Array;
  ct: Uint8Array;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP_RE = /^[0-9a-f]{64}$/;

export function assertShareContext(c: ShareContext): void {
  const intIn = (x: number, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (
    !UUID_RE.test(c.walletId) ||
    !UUID_RE.test(c.keygenId) ||
    !UUID_RE.test(c.participantId) ||
    !intIn(c.parties, 1, 64) ||
    !intIn(c.threshold, 1, c.parties) ||
    !intIn(c.partyIndex, 1, c.parties) ||
    !intIn(c.membershipVersion, 1, Number.MAX_SAFE_INTEGER) ||
    !FP_RE.test(c.fingerprint)
  ) {
    throw new ShareProvisioningError('BAD_CONTEXT', 'Invalid share context');
  }
}

export function envelopeInfo(c: ShareContext): Uint8Array {
  assertShareContext(c);
  return utf8ToBytes(
    [
      'QDWallet-ShareEnvelope', 'v1', c.walletId, c.keygenId, c.participantId,
      c.partyIndex, c.threshold, c.parties, c.membershipVersion, c.fingerprint,
    ].join('|'),
  );
}

/** SHA-256(enc ‖ ct); the backend and the acknowledgement use the same value. */
export function envelopeHash(e: ShareEnvelope): Uint8Array {
  return sha256(concatBytes(e.enc, e.ct));
}

let suite: CipherSuite | undefined;
function hpke(): CipherSuite {
  suite ??= new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  return suite;
}

/** A fresh recipient key pair for one key generation. The private key is a 32-byte seed. */
export async function generateRecipientKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const kem = hpke().kem;
  const kp = await kem.generateKeyPair();
  return {
    publicKey: new Uint8Array(await kem.serializePublicKey(kp.publicKey)),
    privateKey: new Uint8Array(await kem.serializePrivateKey(kp.privateKey)),
  };
}

export async function sealToRecipient(
  recipientPublicKey: Uint8Array,
  context: ShareContext,
  plaintext: Uint8Array,
): Promise<ShareEnvelope> {
  if (recipientPublicKey.length !== XWING_PUBLIC_KEY_BYTES) throw new ShareProvisioningError('BAD_KEY', 'Invalid recipient key');
  const s = hpke();
  let pk: CryptoKey;
  try {
    pk = await s.kem.deserializePublicKey(recipientPublicKey);
  } catch {
    throw new ShareProvisioningError('BAD_KEY', 'Invalid recipient key');
  }
  const { ct, enc } = await s.seal({ recipientPublicKey: pk, info: envelopeInfo(context) }, plaintext);
  return { enc: new Uint8Array(enc), ct: new Uint8Array(ct) };
}

export async function openFromSender(
  recipientPrivateKey: Uint8Array,
  context: ShareContext,
  envelope: ShareEnvelope,
): Promise<Uint8Array> {
  if (recipientPrivateKey.length !== XWING_PRIVATE_KEY_BYTES) throw new ShareProvisioningError('BAD_KEY', 'Invalid private key');
  if (envelope.enc.length !== XWING_ENC_BYTES) throw new ShareProvisioningError('DECRYPTION_FAILED', 'Envelope could not be opened');
  const s = hpke();
  try {
    const sk = await s.kem.deserializePrivateKey(recipientPrivateKey);
    const pt = await s.open({ recipientKey: sk, enc: envelope.enc, info: envelopeInfo(context) }, envelope.ct);
    return new Uint8Array(pt);
  } catch (e) {
    if (e instanceof ShareProvisioningError) throw e;
    // Wrong recipient, wrong context and tampering are indistinguishable by design.
    throw new ShareProvisioningError('DECRYPTION_FAILED', 'Envelope could not be opened');
  }
}
