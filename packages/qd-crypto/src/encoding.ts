import { sha3_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import type { KeyShare } from './keys';
import { K, L, MAX_PARTIES, N, OMEGA, Q, Q_T, Q_W, SEED_BYTES } from './params';
import type { PolyVec } from './poly';
import { encodeU16Vec, type Challenge, type PublicKey, type Signature } from './raccoon';
import { encodeQVec, type Round1Msg, type Round2Msg, type Round3Msg } from './signing';

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

// ---------------------------------------------------------------------------
// Key-share serialization (for encrypted transport and encrypted storage only)
// ---------------------------------------------------------------------------

const KEYSHARE_MAGIC = [0x51, 0x44, 0x4b, 0x53]; // "QDKS"
const KEYSHARE_VERSION = 1;
const QVEC_L_BYTES = L * N * 7;
const QVEC_K_BYTES = K * N * 7;

/** Serialized size of a key share for `parties` participants. */
export function keyShareBytes(parties: number): number {
  return 8 + QVEC_L_BYTES + SEED_BYTES + QVEC_K_BYTES + SEED_BYTES + 2 * parties * SEED_BYTES;
}

function readQVec(bytes: Uint8Array, off: number, len: number, what: string): PolyVec {
  return Array.from({ length: len }, (_, j) => {
    const p = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const o = off + 7 * (j * N + i);
      let x = 0;
      for (let b = 0; b < 7; b++) x = x * 256 + bytes[o + b];
      if (x >= Q) throw new EncodingError(`${what} coefficient out of range`);
      p[i] = x;
    }
    return p;
  });
}

/**
 * Layout: "QDKS" ‖ version ‖ index ‖ T ‖ N ‖ s_i (ℓ·n × u56) ‖ seedA ‖ tFull (k·n × u56)
 *         ‖ chaincode ‖ seedsOut (N × 32) ‖ seedsIn (N × 32).
 * The output is SECRET: it must only ever be passed to an AEAD.
 */
export function encodeKeyShare(key: KeyShare): Uint8Array {
  assertShareShape(key);
  const out = new Uint8Array(keyShareBytes(key.parties));
  out.set(KEYSHARE_MAGIC, 0);
  out.set([KEYSHARE_VERSION, key.index, key.threshold, key.parties], 4);
  let o = 8;
  const put = (b: Uint8Array) => {
    out.set(b, o);
    o += b.length;
  };
  put(encodeQVec(key.share));
  put(key.master.seedA);
  put(encodeQVec(key.master.tFull));
  put(key.chaincode);
  key.seedsOut.forEach(put);
  key.seedsIn.forEach(put);
  return out;
}

export function decodeKeyShare(bytes: Uint8Array): KeyShare {
  if (bytes.length < 8 || KEYSHARE_MAGIC.some((b, i) => bytes[i] !== b)) throw new EncodingError('not a key share');
  if (bytes[4] !== KEYSHARE_VERSION) throw new EncodingError('unsupported key share version');
  const [index, threshold, parties] = [bytes[5], bytes[6], bytes[7]];
  if (threshold < 1 || threshold > parties || parties > MAX_PARTIES || index < 1 || index > parties) {
    throw new EncodingError('key share parameters out of range');
  }
  if (bytes.length !== keyShareBytes(parties)) throw new EncodingError('bad key share length');
  let o = 8;
  const take = (n: number) => bytes.slice(o, (o += n));
  const share = readQVec(bytes, o, L, 'share');
  o += QVEC_L_BYTES;
  const seedA = take(SEED_BYTES);
  const tFull = readQVec(bytes, o, K, 'tFull');
  o += QVEC_K_BYTES;
  const chaincode = take(SEED_BYTES);
  const seedsOut = Array.from({ length: parties }, () => take(SEED_BYTES));
  const seedsIn = Array.from({ length: parties }, () => take(SEED_BYTES));
  const key: KeyShare = { index, threshold, parties, share, seedsOut, seedsIn, master: { seedA, tFull }, chaincode };
  assertShareShape(key);
  return key;
}

function assertShareShape(key: KeyShare): void {
  const okVec = (v: PolyVec, len: number) =>
    v.length === len && v.every((p) => p.length === N && p.every((x) => Number.isInteger(x) && x >= 0 && x < Q));
  const okSeeds = (s: Uint8Array[]) => s.length === key.parties && s.every((x) => x.length === SEED_BYTES);
  if (
    !Number.isInteger(key.index) || key.index < 1 || key.index > key.parties ||
    !Number.isInteger(key.threshold) || key.threshold < 1 || key.threshold > key.parties || key.parties > MAX_PARTIES ||
    !okVec(key.share, L) || !okVec(key.master.tFull, K) ||
    key.master.seedA.length !== SEED_BYTES || key.chaincode.length !== SEED_BYTES ||
    !okSeeds(key.seedsOut) || !okSeeds(key.seedsIn)
  ) {
    throw new EncodingError('malformed key share');
  }
  // seed_{i,i} appears in both directions of the dealer's seed matrix.
  const self = key.index - 1;
  if (key.seedsOut[self].some((b, i) => b !== key.seedsIn[self][i])) throw new EncodingError('inconsistent pairwise seeds');
}

/**
 * Commitment to one key generation: SHA3-256 over (T, N, seedA, tFull, chaincode).
 * Every share of the same `dealerKeyGen` run yields the same value, so it can be
 * published and compared out of band without revealing tFull or the chaincode.
 */
export function masterKeyFingerprint(key: Pick<KeyShare, 'threshold' | 'parties' | 'master' | 'chaincode'>): Uint8Array {
  return sha3_256(
    concatBytes(
      new TextEncoder().encode('QD-master-fingerprint-v1'),
      new Uint8Array([key.threshold, key.parties]),
      key.master.seedA,
      encodeQVec(key.master.tFull),
      key.chaincode,
    ),
  );
}

// ---------------------------------------------------------------------------
// Signing-round messages (public; relayed by the coordinator between signers)
//
//   round 1 = cmt (32) ‖ mask (ℓ·n × u56)
//   round 2 = w (k·n × u56) ‖ for each other active party j, ascending: j (u8) ‖ tag_j (32)
//   round 3 = z (ℓ·n × u56)
//
// The sender's party index is not encoded: the coordinator attaches it from
// the authenticated sender, and decoders take it as `from`.
// ---------------------------------------------------------------------------

export const ROUND1_BYTES = 32 + QVEC_L_BYTES;
export const ROUND3_BYTES = QVEC_L_BYTES;

export function round2Bytes(threshold: number): number {
  return QVEC_K_BYTES + (threshold - 1) * 33;
}

export function encodeRound1(m: Round1Msg): Uint8Array {
  if (m.cmt.length !== 32) throw new EncodingError('bad commitment length');
  return concatBytes(m.cmt, encodeQVec(m.mask));
}

export function decodeRound1(from: number, bytes: Uint8Array): Round1Msg {
  if (bytes.length !== ROUND1_BYTES) throw new EncodingError('bad round-1 length');
  return { from, cmt: bytes.slice(0, 32), mask: readQVec(bytes, 32, L, 'mask') };
}

export function encodeRound2(m: Round2Msg, act: readonly number[]): Uint8Array {
  const others = act.filter((i) => i !== m.from);
  const tags = [...m.tags].sort((a, b) => a.to - b.to);
  if (tags.length !== others.length || tags.some((t, i) => t.to !== others[i] || t.tag.length !== 32)) {
    throw new EncodingError('round-2 tags do not match the active set');
  }
  return concatBytes(encodeQVec(m.w), ...tags.flatMap((t) => [new Uint8Array([t.to]), t.tag]));
}

export function decodeRound2(from: number, bytes: Uint8Array, act: readonly number[]): Round2Msg {
  if (bytes.length !== round2Bytes(act.length)) throw new EncodingError('bad round-2 length');
  const w = readQVec(bytes, 0, K, 'commitment share');
  const others = act.filter((i) => i !== from);
  const tags = others.map((to, i) => {
    const o = QVEC_K_BYTES + 33 * i;
    if (bytes[o] !== to) throw new EncodingError('round-2 tag addressed to the wrong party');
    return { to, tag: bytes.slice(o + 1, o + 33) };
  });
  return { from, w, tags };
}

export function encodeRound3(m: Round3Msg): Uint8Array {
  return encodeQVec(m.z);
}

export function decodeRound3(from: number, bytes: Uint8Array): Round3Msg {
  if (bytes.length !== ROUND3_BYTES) throw new EncodingError('bad round-3 length');
  return { from, z: readQVec(bytes, 0, L, 'response share') };
}
