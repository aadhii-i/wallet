import { invMod, powMod } from './field';
import { N, P1, P2 } from './params';

/**
 * Negacyclic NTT over Z_p[X]/(X^n + 1) for one prime p ≡ 1 (mod 2n).
 * Cooley–Tukey forward, Gentleman–Sande inverse, with twiddles ψ^{brv(i)}
 * (the Dilithium reference layout). The output is in bit-reversed order,
 * and pointwise products in that domain are ring products.
 */
interface Tables {
  p: number;
  zetas: Float64Array;
  nInv: number;
}

function bitReverse(i: number, bits: number): number {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  return r;
}

/** Smallest-generator primitive 2n-th root of unity mod p. */
export function primitiveRoot2n(p: number): bigint {
  const pb = BigInt(p);
  for (let g = 2n; g < pb; g++) {
    const psi = powMod(g, (pb - 1n) / BigInt(2 * N), pb);
    // 2n is a power of two, so ψ^n = −1 means that ψ has order exactly 2n.
    if (powMod(psi, BigInt(N), pb) === pb - 1n) return psi;
  }
  throw new Error('qd-crypto: no primitive root');
}

function makeTables(p: number): Tables {
  const psi = primitiveRoot2n(p);
  const pb = BigInt(p);
  const bits = Math.log2(N);
  const zetas = new Float64Array(N);
  for (let i = 0; i < N; i++) zetas[i] = Number(powMod(psi, BigInt(bitReverse(i, bits)), pb));
  return { p, zetas, nInv: Number(invMod(BigInt(N), pb)) };
}

export const T1 = makeTables(P1);
export const T2 = makeTables(P2);

export function nttForward(a: Float64Array, t: Tables): void {
  const { p, zetas } = t;
  let k = 0;
  for (let len = N >> 1; len > 0; len >>= 1) {
    for (let start = 0; start < N; start += len << 1) {
      const zeta = zetas[++k];
      for (let j = start; j < start + len; j++) {
        const u = a[j];
        const v = (zeta * a[j + len]) % p;
        const s = u + v;
        a[j] = s >= p ? s - p : s;
        const d = u - v;
        a[j + len] = d < 0 ? d + p : d;
      }
    }
  }
}

export function nttInverse(a: Float64Array, t: Tables): void {
  const { p, zetas, nInv } = t;
  let k = N;
  for (let len = 1; len < N; len <<= 1) {
    for (let start = 0; start < N; start += len << 1) {
      const zeta = p - zetas[--k];
      for (let j = start; j < start + len; j++) {
        const u = a[j];
        const v = a[j + len];
        const s = u + v;
        a[j] = s >= p ? s - p : s;
        const d = u - v;
        a[j + len] = (zeta * (d < 0 ? d + p : d)) % p;
      }
    }
  }
  for (let i = 0; i < N; i++) a[i] = (a[i] * nInv) % p;
}
