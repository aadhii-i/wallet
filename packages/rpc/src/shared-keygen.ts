/**
 * Client side of shared-wallet key generation (trusted dealer). Only public
 * values pass through here: X-Wing public keys, opaque HPKE envelopes,
 * fingerprints and device signatures. Secret material lives in the key worker.
 *
 * The signed message formats mirror services/wallet-api/internal/sharedwallet/keygen.go.
 */
import type { SharedWallet } from './shared-wallets';

export type KeygenStatus = 'collecting_keys' | 'dealing' | 'awaiting_provisioning' | 'complete' | 'failed';
export type KeyInitStatus = 'not_initialized' | 'in_progress' | 'awaiting_provisioning' | 'initialized' | 'failed' | 'rekey_required';
export type KeygenFailReason = 'cancelled' | 'decryption_failed' | 'share_verification_failed';

export interface KeyGenerationSummary {
  id: string;
  status: KeygenStatus;
  failureReason: string;
  threshold: number;
  parties: number;
  membershipVersion: number;
  dealerParticipantId: string;
  fingerprint: string | null;
  keysRegistered: number;
  provisioned: number;
  createdAt: string;
  expiresAt: string;
  endedAt?: string;
}

export interface KeygenParticipant {
  participantId: string;
  partyIndex: number;
  /** base64url X-Wing public key, once registered. */
  encryptionKey: string | null;
  keyRegistered: boolean;
  envelopeStaged: boolean;
  provisioned: boolean;
}

export interface KeyGeneration extends KeyGenerationSummary {
  participants: KeygenParticipant[];
  me: { participantId: string; partyIndex: number } | null;
}

export interface SharedWalletKey {
  status: KeyInitStatus;
  generation?: KeyGenerationSummary;
  keyGenerationId?: string;
  fingerprint?: string;
}

export interface MyEnvelope {
  walletId: string;
  keygenId: string;
  participantId: string;
  partyIndex: number;
  threshold: number;
  parties: number;
  membershipVersion: number;
  fingerprint: string;
  enc: string;
  ct: string;
  envelopeHash: string;
}

export class KeygenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeygenRefusedError';
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))));
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function toB64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256(enc ‖ ct), hex. */
export async function envelopeHashHex(enc: Uint8Array, ct: Uint8Array): Promise<string> {
  const all = new Uint8Array(enc.length + ct.length);
  all.set(enc);
  all.set(ct, enc.length);
  return sha256Hex(all);
}

export async function keygenKeyMessage(walletId: string, kg: KeyGenerationSummary, participantId: string, partyIndex: number, encryptionKey: Uint8Array): Promise<string> {
  return ['QDWallet-KeygenKey', 'v1', walletId, kg.id, participantId, partyIndex, kg.membershipVersion, await sha256Hex(encryptionKey)].join('|');
}

export async function envelopesDigestHex(envelopes: { partyIndex: number; participantId: string; hashHex: string }[]): Promise<string> {
  const lines = [...envelopes].sort((a, b) => a.partyIndex - b.partyIndex).map((e) => `${e.partyIndex}:${e.participantId}:${e.hashHex}`);
  return sha256Hex(new TextEncoder().encode(lines.join(';')));
}

export function keygenDealMessage(walletId: string, kg: KeyGenerationSummary, fingerprint: string, envelopesDigest: string): string {
  return ['QDWallet-KeygenDeal', 'v1', walletId, kg.id, kg.membershipVersion, kg.threshold, kg.parties, fingerprint, envelopesDigest].join('|');
}

export function keygenAckMessage(e: MyEnvelope, envelopeHash: string): string {
  return [
    'QDWallet-KeygenAck', 'v1', e.walletId, e.keygenId, e.participantId, e.partyIndex,
    e.threshold, e.parties, e.membershipVersion, e.fingerprint, envelopeHash,
  ].join('|');
}

/**
 * A short number every participant computes from the encryption keys the
 * server shows them. If all participants (and the dealer) read out the same
 * number over a trusted channel, the server did not substitute any key.
 */
export async function keygenSafetyNumber(walletId: string, kg: KeyGeneration): Promise<string | null> {
  if (kg.participants.some((p) => !p.encryptionKey)) return null;
  const parts = await Promise.all(
    [...kg.participants]
      .sort((a, b) => a.partyIndex - b.partyIndex)
      .map(async (p) => `${p.partyIndex}:${p.participantId}:${await sha256Hex(fromB64url(p.encryptionKey!))}`),
  );
  const s = ['QDWallet-KeygenSafety', 'v1', walletId, kg.id, kg.threshold, kg.parties, kg.membershipVersion, parts.join(';')].join('|');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const view = new DataView(d.buffer);
  return Array.from({ length: 6 }, (_, i) => String(view.getUint32(i * 4) % 100000).padStart(5, '0')).join(' ');
}

/**
 * Refuses a ceremony that does not match the wallet as this client sees it:
 * the active participants, their count, the membership version, and
 * T = ceil(N × policy). Called before registering a key and before dealing.
 */
export function checkKeygenAgainstWallet(wallet: SharedWallet, kg: KeyGeneration): void {
  const active = wallet.participants.filter((p) => p.status === 'active').map((p) => p.id).sort();
  const parties = kg.participants.map((p) => p.participantId).sort();
  const indices = kg.participants.map((p) => p.partyIndex).sort((a, b) => a - b);
  const expectedT = Math.ceil((kg.parties * wallet.policy.numerator) / wallet.policy.denominator);
  if (
    kg.membershipVersion !== wallet.policy.membershipVersion ||
    kg.parties !== active.length ||
    kg.participants.length !== kg.parties ||
    parties.join(',') !== active.join(',') ||
    !indices.every((v, i) => v === i + 1) ||
    kg.threshold !== expectedT ||
    kg.parties > 64
  ) {
    throw new KeygenRefusedError('Key generation does not match this wallet’s participants or policy');
  }
}
