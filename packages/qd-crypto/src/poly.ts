import { centered, garner, modQ, mulModQ } from './field';
import { nttForward, nttInverse, T1, T2 } from './ntt';
import { N, P1, P2, Q } from './params';

/** Coefficients in [0, m) for the relevant modulus m (usually q). */
export type Poly = Float64Array;
export type PolyVec = Poly[];

/** A polynomial in the NTT domain, one residue vector per CRT prime. */
export interface NttPoly {
  a: Float64Array;
  b: Float64Array;
}

export function zeroPoly(): Poly {
  return new Float64Array(N);
}

export function toNtt(x: Poly): NttPoly {
  const a = new Float64Array(N);
  const b = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    a[i] = x[i] % P1;
    b[i] = x[i] % P2;
  }
  nttForward(a, T1);
  nttForward(b, T2);
  return { a, b };
}

/** Consumes (mutates) its argument. */
export function fromNtt(x: NttPoly): Poly {
  nttInverse(x.a, T1);
  nttInverse(x.b, T2);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = garner(x.a[i], x.b[i]);
  return out;
}

function nttMulAcc(acc: NttPoly, x: NttPoly, y: NttPoly): void {
  for (let i = 0; i < N; i++) {
    acc.a[i] = (acc.a[i] + ((x.a[i] * y.a[i]) % P1)) % P1;
    acc.b[i] = (acc.b[i] + ((x.b[i] * y.b[i]) % P2)) % P2;
  }
}

function nttZero(): NttPoly {
  return { a: new Float64Array(N), b: new Float64Array(N) };
}

export function mulNtt(x: NttPoly, y: NttPoly): Poly {
  const acc = nttZero();
  nttMulAcc(acc, x, y);
  return fromNtt(acc);
}

export function polyMul(x: Poly, y: Poly): Poly {
  return mulNtt(toNtt(x), toNtt(y));
}

/** A·v for A (k×ℓ, NTT domain) and v ∈ R_q^ℓ. */
export function matVec(A: NttPoly[][], v: PolyVec): PolyVec {
  const vHat = v.map(toNtt);
  return A.map((row) => {
    const acc = nttZero();
    row.forEach((aij, j) => nttMulAcc(acc, aij, vHat[j]));
    return fromNtt(acc);
  });
}

export function addQ(x: Poly, y: Poly): Poly {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = x[i] + y[i];
    out[i] = s >= Q ? s - Q : s;
  }
  return out;
}

export function subQ(x: Poly, y: Poly): Poly {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const d = x[i] - y[i];
    out[i] = d < 0 ? d + Q : d;
  }
  return out;
}

export function scaleQ(x: Poly, scalar: number): Poly {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = mulModQ(x[i], scalar);
  return out;
}

export function addVecQ(x: PolyVec, y: PolyVec): PolyVec {
  return x.map((p, i) => addQ(p, y[i]));
}

export function subVecQ(x: PolyVec, y: PolyVec): PolyVec {
  return x.map((p, i) => subQ(p, y[i]));
}

/** Polynomial from signed integer coefficients. */
export function fromSigned(values: ArrayLike<number>): Poly {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = modQ(values[i]);
  return out;
}

/** ⌊x⌉_ν = ⌊(x + 2^{ν−1}) / 2^ν⌋ mod q_ν, for x ∈ [0, q). */
export function roundPoly(x: Poly, nu: number, qNu: number): Poly {
  const half = 2 ** (nu - 1);
  const div = 2 ** nu;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.floor((x[i] + half) / div) % qNu;
  return out;
}

/** Lift a rounded polynomial (coefficients in [0, q_ν)) back to 2^ν·x mod q. */
export function liftPoly(x: Poly, nu: number): Poly {
  const mul = 2 ** nu;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = modQ(x[i] * mul);
  return out;
}

export function sqNorm(x: Poly): number {
  let s = 0;
  for (let i = 0; i < N; i++) {
    const c = centered(x[i]);
    s += c * c;
  }
  return s;
}

export function polyEquals(x: Poly, y: Poly): boolean {
  for (let i = 0; i < N; i++) if (x[i] !== y[i]) return false;
  return true;
}
