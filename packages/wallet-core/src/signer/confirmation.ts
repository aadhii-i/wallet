import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { toHex, utf8ToBytes, bytesToHex } from '../encoding';
import { SignerError, type ConfirmationToken, type Hex, type SigningPayload } from './types';

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Canonical, unambiguous hash of a payload. Field order is fixed. */
export function hashPayload(payload: SigningPayload): Hex {
  let canonical: string;
  switch (payload.kind) {
    case 'evm-transaction':
      canonical = `evm-transaction|${payload.chainId}|${payload.from.toLowerCase()}|${payload.serializedUnsigned.toLowerCase()}`;
      break;
    case 'evm-personal-message':
      canonical = `evm-personal-message|${payload.from.toLowerCase()}|${payload.message.toLowerCase()}`;
      break;
  }
  return toHex(sha256(utf8ToBytes(canonical)));
}

/**
 * Issues and consumes confirmation tokens. Lives next to the signer (inside the key
 * worker on web), so a token is only valid for the payload that was reviewed.
 *
 * Limitation: this guarantees consistency between review and signing inside our own
 * pipeline. It does not defend against code that controls the whole JS context (T3).
 */
export class ConfirmationRegistry {
  private readonly pending = new Map<string, ConfirmationToken>();
  private readonly consumed = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(payload: SigningPayload): ConfirmationToken {
    this.prune();
    const token: ConfirmationToken = {
      id: bytesToHex(randomBytes(16)),
      payloadHash: hashPayload(payload),
      issuedAt: this.now(),
    };
    this.pending.set(token.id, token);
    return token;
  }

  /** Validates and burns a token. Throws SignerError on any mismatch. */
  consume(token: ConfirmationToken | undefined, payload: SigningPayload): void {
    if (!token) throw new SignerError('CONFIRMATION_MISSING', 'Signing requires user confirmation');
    if (this.consumed.has(token.id)) {
      throw new SignerError('CONFIRMATION_REUSED', 'This confirmation was already used');
    }
    const issued = this.pending.get(token.id);
    if (!issued || issued.payloadHash !== token.payloadHash) {
      throw new SignerError('CONFIRMATION_MISMATCH', 'Confirmation was not issued for this request');
    }
    if (issued.payloadHash !== hashPayload(payload)) {
      throw new SignerError('CONFIRMATION_MISMATCH', 'Transaction changed after it was reviewed');
    }
    this.pending.delete(token.id);
    this.consumed.add(token.id);
    if (this.now() - issued.issuedAt > CONFIRMATION_TTL_MS) {
      throw new SignerError('CONFIRMATION_EXPIRED', 'Confirmation expired. Review the transaction again');
    }
  }

  revokeAll(): void {
    this.pending.clear();
  }

  private prune(): void {
    const cutoff = this.now() - CONFIRMATION_TTL_MS;
    for (const [id, t] of this.pending) if (t.issuedAt < cutoff) this.pending.delete(id);
  }
}
