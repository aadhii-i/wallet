import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import {
  K,
  L,
  MSG_BYTES,
  N,
  NORM_BOUND,
  NU_T,
  NU_W,
  OMEGA,
  Q,
  Q_T,
  Q_W,
  SEED_BYTES,
} from './params';
import {
  liftPoly,
  matVec,
  mulNtt,
  roundPoly,
  sqNorm,
  subQ,
  toNtt,
  type NttPoly,
  type Poly,
  type PolyVec,
} from './poly';
import { Xof, u32be } from './sample';

/**
 * Raccoon verification key as published for an account: the matrix seed and
 * the rounded vector t ∈ R_{q_t}^k.
 */
export interface PublicKey {
  seedA: Uint8Array;
  t: PolyVec;
}

/** ω distinct positions with signs, in generation order. */
export interface Challenge {
  positions: number[];
  negative: boolean[];
}

export interface Signature {
  c: Challenge;
  /** z ∈ R_q^ℓ */
  z: PolyVec;
  /** h ∈ R_{q_w}^k */
  h: PolyVec;
}

// ---------------------------------------------------------------------------
// Public matrix
// ---------------------------------------------------------------------------

const aCache = new Map<string, NttPoly[][]>();

/** A ∈ R_q^{k×ℓ}, expanded from its seed with SHAKE256, in the NTT domain. */
export function expandA(seedA: Uint8Array): NttPoly[][] {
  const key = bytesToHex(seedA);
  const hit = aCache.get(key);
  if (hit) return hit;
  const A = Array.from({ length: K }, (_, i) =>
    Array.from({ length: L }, (_, j) =>
      toNtt(new Xof('QD-A', seedA, new Uint8Array([i, j])).uniformPoly()),
    ),
  );
  if (aCache.size > 32) aCache.clear();
  aCache.set(key, A);
  return A;
}

// ---------------------------------------------------------------------------
// Hashing. Keccak-256 (not SHAKE) so that an EVM contract can recompute the
// challenge with the native KECCAK256 opcode (ADR 0014).
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const DOM_VK = enc.encode('QD-VK-v1');
const DOM_HC = enc.encode('QD-Hc-v1');

/** Big-endian u16 per coefficient; for polynomials mod q_t or q_w. */
export function encodeU16Vec(v: PolyVec): Uint8Array {
  const out = new Uint8Array(v.length * N * 2);
  let o = 0;
  for (const p of v) {
    for (let i = 0; i < N; i++) {
      out[o++] = p[i] >>> 8;
      out[o++] = p[i] & 255;
    }
  }
  return out;
}

export function encodePublicKey(pk: PublicKey): Uint8Array {
  return concatBytes(pk.seedA, encodeU16Vec(pk.t));
}

export function publicKeyHash(pk: PublicKey): Uint8Array {
  return keccak_256(concatBytes(DOM_VK, encodePublicKey(pk)));
}

/** c = ChalGen(keccak256("QD-Hc-v1" ‖ H(vk) ‖ msg ‖ w)). */
export function challenge(vkHash: Uint8Array, msg: Uint8Array, w: PolyVec): Challenge {
  const seed = keccak_256(concatBytes(DOM_HC, vkHash, msg, encodeU16Vec(w)));
  const used = new Set<number>();
  const positions: number[] = [];
  const negative: boolean[] = [];
  for (let ctr = 0; positions.length < OMEGA; ctr++) {
    const block = keccak_256(concatBytes(seed, u32be(ctr)));
    for (let i = 0; i < 32 && positions.length < OMEGA; i += 2) {
      const v = (block[i] << 8) | block[i + 1];
      const pos = v & (N - 1);
      if (used.has(pos)) continue;
      used.add(pos);
      positions.push(pos);
      negative.push(v >> 15 === 1);
    }
  }
  return { positions, negative };
}

export function challengePoly(c: Challenge): Poly {
  const out = new Float64Array(N);
  c.positions.forEach((pos, i) => {
    out[pos] = c.negative[i] ? Q - 1 : 1;
  });
  return out;
}

function challengeEquals(x: Challenge, y: Challenge): boolean {
  return (
    x.positions.length === y.positions.length &&
    x.positions.every((p, i) => p === y.positions[i] && x.negative[i] === y.negative[i])
  );
}

// ---------------------------------------------------------------------------
// Commitment reconstruction (shared by Combine and Verify)
// ---------------------------------------------------------------------------

/** ⌊A·z − 2^νt·c·t⌉_νw. */
export function commitmentFromResponse(pk: PublicKey, c: Challenge, z: PolyVec): PolyVec {
  const A = expandA(pk.seedA);
  const Az = matVec(A, z);
  const cHat = toNtt(challengePoly(c));
  return Az.map((azi, i) => {
    const cti = mulNtt(cHat, toNtt(liftPoly(pk.t[i], NU_T)));
    return roundPoly(subQ(azi, cti), NU_W, Q_W);
  });
}

// ---------------------------------------------------------------------------
// Verification (TRaccoon Alg. 3; identical for threshold and derived keys)
// ---------------------------------------------------------------------------

function inRange(v: PolyVec, len: number, bound: number): boolean {
  return (
    v.length === len &&
    v.every((p) => p.length === N && p.every((x) => Number.isInteger(x) && x >= 0 && x < bound))
  );
}

function wellFormed(pk: PublicKey, sig: Signature): boolean {
  const { positions, negative } = sig.c;
  return (
    pk.seedA.length === SEED_BYTES &&
    inRange(pk.t, K, Q_T) &&
    positions.length === OMEGA &&
    negative.length === OMEGA &&
    new Set(positions).size === OMEGA &&
    positions.every((p) => Number.isInteger(p) && p >= 0 && p < N) &&
    inRange(sig.z, L, Q) &&
    inRange(sig.h, K, Q_W)
  );
}

/** ‖(z, 2^νw·h)‖₂², with each coefficient centred mod q. */
export function signatureSqNorm(sig: Signature): number {
  let s = 0;
  for (const p of sig.z) s += sqNorm(p);
  for (const p of sig.h) s += sqNorm(liftPoly(p, NU_W));
  return s;
}

export function verify(pk: PublicKey, msg: Uint8Array, sig: Signature): boolean {
  if (msg.length !== MSG_BYTES || !wellFormed(pk, sig)) return false;
  if (signatureSqNorm(sig) > NORM_BOUND * NORM_BOUND) return false;
  const y = commitmentFromResponse(pk, sig.c, sig.z);
  const w = y.map((yi, i) => {
    const out = new Float64Array(N);
    for (let j = 0; j < N; j++) out[j] = (yi[j] + sig.h[i][j]) % Q_W;
    return out;
  });
  return challengeEquals(challenge(publicKeyHash(pk), msg, w), sig.c);
}

/** h = w − y mod q_w. */
export function hint(w: PolyVec, y: PolyVec): PolyVec {
  return w.map((wi, i) => {
    const out = new Float64Array(N);
    for (let j = 0; j < N; j++) out[j] = (wi[j] - y[i][j] + Q_W) % Q_W;
    return out;
  });
}

