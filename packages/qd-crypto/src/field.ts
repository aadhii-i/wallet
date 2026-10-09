import { P1, P2, Q } from './params';

// Scalars mod q are plain numbers in [0, q). q < 2^49, so sums of two stay
// exact. Products are formed per prime (both < 2^25, so products < 2^50) and
// recombined with Garner's CRT.

export function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function invMod(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quot = oldR / r;
    [oldR, r] = [r, oldR - quot * r];
    [oldS, s] = [s, oldS - quot * s];
  }
  if (oldR !== 1n) throw new Error('qd-crypto: value is not invertible');
  return ((oldS % m) + m) % m;
}

const P1_INV_MOD_P2 = Number(invMod(BigInt(P1), BigInt(P2)));
const HALF_Q = (Q - 1) / 2;

/** Reduce any safe integer into [0, q). */
export function modQ(x: number): number {
  const r = x % Q;
  return r < 0 ? r + Q : r;
}

/** Representative of x ∈ [0, q) in (−q/2, q/2]. */
export function centered(x: number): number {
  return x > HALF_Q ? x - Q : x;
}

/** The unique x ∈ [0, q) with x ≡ x1 (mod p1) and x ≡ x2 (mod p2). */
export function garner(x1: number, x2: number): number {
  let d = (x2 - (x1 % P2)) % P2;
  if (d < 0) d += P2;
  return x1 + P1 * ((d * P1_INV_MOD_P2) % P2);
}

export function mulModQ(a: number, b: number): number {
  return garner(((a % P1) * (b % P1)) % P1, ((a % P2) * (b % P2)) % P2);
}

/** λ_{act,j} = Π_{m ∈ act, m ≠ j} m / (m − j)  (mod q). */
export function lagrangeAtZero(act: readonly number[], j: number): number {
  const q = BigInt(Q);
  let num = 1n;
  let den = 1n;
  for (const m of act) {
    if (m === j) continue;
    num = (num * BigInt(m)) % q;
    den = (den * (((BigInt(m - j) % q) + q) % q)) % q;
  }
  return Number((num * invMod(den, q)) % q);
}
