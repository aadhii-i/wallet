import { K, L, N, OMEGA, Q, Q_T, Q_W, SEED_BYTES } from './params';
import { encodeU16Vec, type Challenge, type PublicKey, type Signature } from './raccoon';
import { encodeQVec } from './signing';

/**
 * Fixed-width wire formats, chosen so a Solidity verifier can index straight
 * into calldata:
 *
 *   signature = c: ω × u16 (bit 15 = negative, bits 0–8 = position)
 *             ‖ z: ℓ·n × u56 (value mod q)
 *             ‖ h: k·n × u16 (value mod q_w)
 *   publicKey = seedA (32 bytes) ‖ t: k·n × u16 (value mod q_t)
 */
export const SIGNATURE_BYTES = OMEGA * 2 + L * N * 7 + K * N * 2;
export const PUBLIC_KEY_BYTES = SEED_BYTES + K * N * 2;

export class EncodingError extends Error {
  constructor(message: string) {
    super(`qd-crypto: ${message}`);
    this.name = 'EncodingError';
  }
}

export function encodeSignature(sig: Signature): Uint8Array {
  const out = new Uint8Array(SIGNATURE_BYTES);
  sig.c.positions.forEach((pos, i) => {
    const v = pos | (sig.c.negative[i] ? 0x8000 : 0);
    out[2 * i] = v >>> 8;
    out[2 * i + 1] = v & 255;
  });
  out.set(encodeQVec(sig.z), OMEGA * 2);
  out.set(encodeU16Vec(sig.h), OMEGA * 2 + L * N * 7);
  return out;
}

function readU16Vec(bytes: Uint8Array, off: number, len: number, bound: number, what: string) {
  return Array.from({ length: len }, (_, j) => {
    const p = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const o = off + 2 * (j * N + i);
      p[i] = (bytes[o] << 8) | bytes[o + 1];
      if (p[i] >= bound) throw new EncodingError(`${what} coefficient out of range`);
    }
    return p;
  });
}

export function decodeSignature(bytes: Uint8Array): Signature {
  if (bytes.length !== SIGNATURE_BYTES) throw new EncodingError('bad signature length');
  const c: Challenge = { positions: [], negative: [] };
  for (let i = 0; i < OMEGA; i++) {
    const v = (bytes[2 * i] << 8) | bytes[2 * i + 1];
    if ((v & 0x7e00) !== 0) throw new EncodingError('bad challenge encoding');
    c.positions.push(v & (N - 1));
    c.negative.push((v & 0x8000) !== 0);
  }
  let off = OMEGA * 2;
  const z = Array.from({ length: L }, () => {
    const p = new Float64Array(N);
    for (let i = 0; i < N; i++, off += 7) {
      let x = 0;
      for (let b = 0; b < 7; b++) x = x * 256 + bytes[off + b];
      if (x >= Q) throw new EncodingError('z coefficient out of range');
      p[i] = x;
    }
    return p;
  });
  const h = readU16Vec(bytes, off, K, Q_W, 'h');
  return { c, z, h };
}

export function decodePublicKey(bytes: Uint8Array): PublicKey {
  if (bytes.length !== PUBLIC_KEY_BYTES) throw new EncodingError('bad public key length');
  return {
    seedA: bytes.slice(0, SEED_BYTES),
    t: readU16Vec(bytes, SEED_BYTES, K, Q_T, 't'),
  };
}
