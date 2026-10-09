import { shake256 } from '@noble/hashes/sha3.js';
import { modQ } from './field';
import { N, Q } from './params';
import type { Poly, PolyVec } from './poly';

// ---------------------------------------------------------------------------
// Fresh randomness (CSPRNG). Used for secrets, commitments and dealer seeds.
// ---------------------------------------------------------------------------

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
  }
  return out;
}

class Uniform53 {
  private buf = new Uint32Array(2048);
  private pos = this.buf.length;

  next(): number {
    if (this.pos + 2 > this.buf.length) {
      globalThis.crypto.getRandomValues(this.buf);
      this.pos = 0;
    }
    const hi = this.buf[this.pos++] >>> 5;
    const lo = this.buf[this.pos++] >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992; // [0, 1), 53 bits
  }
}

const uniform = new Uniform53();

/**
 * Rounded Gaussian with standard deviation σ (Marsaglia polar method).
 * TRaccoon's own implementation uses the same sampler (§9 and Appendix E).
 * Not constant-time. See ADR 0014, "side channels".
 */
export function gaussianPoly(sigma: number): Poly {
  const out = new Float64Array(N);
  let i = 0;
  while (i < N) {
    const u = 2 * uniform.next() - 1;
    const v = 2 * uniform.next() - 1;
    const s = u * u + v * v;
    if (s >= 1 || s === 0) continue;
    const f = Math.sqrt((-2 * Math.log(s)) / s) * sigma;
    out[i++] = modQ(Math.round(u * f));
    if (i < N) out[i++] = modQ(Math.round(v * f));
  }
  return out;
}

export function gaussianVec(len: number, sigma: number): PolyVec {
  return Array.from({ length: len }, () => gaussianPoly(sigma));
}

// ---------------------------------------------------------------------------
// Deterministic expansion (SHAKE256). Integer-only, so it is reproducible on
// every platform: device, co-signer and tests all derive identical values.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const CHUNK = 8 * 136; // whole SHAKE256 blocks

export function u32be(x: number): Uint8Array {
  return new Uint8Array([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
}

export class Xof {
  private readonly h = shake256.create();
  private buf = new Uint8Array(0);
  private off = 0;

  /** The domain label is length-prefixed; the other parts must be fixed-length. */
  constructor(domain: string, ...parts: Uint8Array[]) {
    const d = enc.encode(domain);
    this.h.update(new Uint8Array([d.length]));
    this.h.update(d);
    for (const p of parts) this.h.update(p);
  }

  read(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (this.off === this.buf.length) {
        this.buf = this.h.xof(CHUNK);
        this.off = 0;
      }
      const take = Math.min(n - filled, this.buf.length - this.off);
      out.set(this.buf.subarray(this.off, this.off + take), filled);
      this.off += take;
      filled += take;
    }
    return out;
  }

  /** Uniform in R_q by rejection sampling of 49-bit values. */
  uniformPoly(): Poly {
    const out = new Float64Array(N);
    let i = 0;
    while (i < N) {
      const b = this.read(7 * (N - i));
      for (let o = 0; o < b.length && i < N; o += 7) {
        const v =
          (b[o] & 1) * 2 ** 48 +
          b[o + 1] * 2 ** 40 +
          b[o + 2] * 2 ** 32 +
          b[o + 3] * 2 ** 24 +
          b[o + 4] * 2 ** 16 +
          b[o + 5] * 2 ** 8 +
          b[o + 6];
        if (v < Q) out[i++] = v;
      }
    }
    return out;
  }

  /** Coefficients uniform in [−bound, bound). bound must be a power of two ≤ 2^23. */
  smallPoly(bound: number): Poly {
    const bits = Math.log2(bound) + 1;
    const mask = 2 ** bits - 1;
    const b = this.read(3 * N);
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const v = ((b[3 * i] << 16) | (b[3 * i + 1] << 8) | b[3 * i + 2]) & mask;
      out[i] = modQ(v - bound);
    }
    return out;
  }
}
