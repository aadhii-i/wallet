import { describe, expect, it } from 'vitest';
import {
  K,
  L,
  N,
  NORM_BOUND,
  PUBLIC_KEY_BYTES,
  Q,
  Q_T,
  Q_W,
  QdParty,
  SIGNATURE_BYTES,
  SigningError,
  accountPublicKey,
  combine,
  dealerKeyGen,
  decodePublicKey,
  decodeSignature,
  deriveShare,
  encodePublicKey,
  encodeSignature,
  signLocally,
  signatureSqNorm,
  verify,
  type SignRequest,
  type Signature,
} from '../src';
import { centered, garner, lagrangeAtZero, modQ, mulModQ } from '../src/field';
import { polyMul, roundPoly } from '../src/poly';
import { randomBytes } from '../src/sample';

const Qb = BigInt(Q);

function randomPoly(): Float64Array {
  const p = new Float64Array(N);
  for (let i = 0; i < N; i++) p[i] = Math.floor(Math.random() * Q);
  return p;
}

function schoolbookNegacyclic(a: Float64Array, b: Float64Array): bigint[] {
  const out = new Array<bigint>(N).fill(0n);
  for (let i = 0; i < N; i++) {
    const ai = BigInt(a[i]);
    if (ai === 0n) continue;
    for (let j = 0; j < N; j++) {
      const k = i + j;
      const prod = ai * BigInt(b[j]);
      if (k < N) out[k] += prod;
      else out[k - N] -= prod;
    }
  }
  return out.map((x) => ((x % Qb) + Qb) % Qb);
}

function request(act: number[], derivationIndex = 0, msg = randomBytes(32)): SignRequest {
  return { sid: randomBytes(32), act, derivationIndex, msg };
}

function setup(threshold: number, parties: number) {
  const dealer = dealerKeyGen(threshold, parties);
  return { dealer, parties: dealer.shares.map((k) => new QdParty(k)) };
}

describe('field and ring arithmetic', () => {
  it('Garner CRT and mulModQ agree with BigInt', () => {
    for (let i = 0; i < 200; i++) {
      const a = Math.floor(Math.random() * Q);
      const b = Math.floor(Math.random() * Q);
      expect(BigInt(mulModQ(a, b))).toBe((BigInt(a) * BigInt(b)) % Qb);
      expect(garner(a % 33_292_289, a % 16_515_073)).toBe(a);
    }
    expect(modQ(-1)).toBe(Q - 1);
    expect(centered(Q - 1)).toBe(-1);
  });

  it('NTT multiplication matches schoolbook negacyclic multiplication mod q', () => {
    const a = randomPoly();
    const b = randomPoly();
    const got = Array.from(polyMul(a, b), (x) => BigInt(x));
    expect(got).toEqual(schoolbookNegacyclic(a, b));
  });

  it('X · X^{n−1} = −1 in R_q', () => {
    const x = new Float64Array(N);
    x[1] = 1;
    const y = new Float64Array(N);
    y[N - 1] = 1;
    const p = polyMul(x, y);
    expect(p[0]).toBe(Q - 1);
    expect(p.slice(1).every((v) => v === 0)).toBe(true);
  });

  it('rounding maps into [0, q_ν) and wraps q − 1 to 0', () => {
    const p = new Float64Array(N);
    p[0] = Q - 1;
    p[1] = 2 ** 36; // exactly half a step rounds up
    p[2] = 2 ** 36 - 1;
    const r = roundPoly(p, 37, Q_T);
    expect([r[0], r[1], r[2]]).toEqual([0, 1, 0]);
    expect(roundPoly(randomPoly(), 40, Q_W).every((v) => v >= 0 && v < Q_W)).toBe(true);
  });

  it('Lagrange coefficients reconstruct the constant term', () => {
    // f(x) = 5 + 3x + 7x² over Z_q, act = {1, 3, 4}
    const f = (x: number) => modQ(5 + 3 * x + 7 * x * x);
    const act = [1, 3, 4];
    const sum = act.reduce((acc, i) => modQ(acc + mulModQ(lagrangeAtZero(act, i), f(i))), 0);
    expect(sum).toBe(5);
  });
});

describe('threshold signing with QD rerandomised keys', () => {
  it.each([
    [1, 1, [1]],
    [2, 3, [1, 2]],
    [2, 3, [1, 3]],
    [2, 3, [2, 3]],
    [3, 5, [1, 3, 5]],
  ])('T=%i, N=%i, act=%j produces a valid signature', (T, Nn, act) => {
    const { parties } = setup(T, Nn);
    const req = request(act, 7);
    const sig = signLocally(parties, req);
    expect(verify(parties[0].publicKey(7), req.msg, sig)).toBe(true);
    // Honest norms sit well below the bound.
    expect(Math.sqrt(signatureSqNorm(sig)) / NORM_BOUND).toBeLessThan(0.7);
  });

  it('every party derives the same account key; accounts differ; derivation is deterministic', () => {
    const { dealer, parties } = setup(2, 3);
    const enc = (i: number, p = 0) => encodePublicKey(parties[p].publicKey(i));
    expect(enc(0, 0)).toEqual(enc(0, 1));
    expect(enc(0, 2)).toEqual(enc(0, 0));
    expect(enc(0)).not.toEqual(enc(1));
    expect(encodePublicKey(accountPublicKey(dealer.shares[0], 5))).toEqual(enc(5));
  });

  it('rerandomised shares still form a Shamir sharing of the session secret', () => {
    const { dealer } = setup(2, 3);
    const s1 = deriveShare(dealer.shares[0], 9);
    const s2 = deriveShare(dealer.shares[1], 9);
    const s3 = deriveShare(dealer.shares[2], 9);
    const rec = (a: Float64Array[], b: Float64Array[], ia: number, ib: number) => {
      const la = lagrangeAtZero([ia, ib], ia);
      const lb = lagrangeAtZero([ia, ib], ib);
      return a.map((p, j) => p.map((x, k) => modQ(mulModQ(la, x) + mulModQ(lb, b[j][k]))));
    };
    const r12 = rec(s1, s2, 1, 2);
    expect(rec(s1, s3, 1, 3)).toEqual(r12);
    expect(rec(s2, s3, 2, 3)).toEqual(r12);
    // The session secret s + f(0) is short (|coefficient| ≲ 2^23).
    expect(r12.every((p) => p.every((x) => Math.abs(centered(x)) < 2 ** 23))).toBe(true);
  });

  it('a signature for one account does not verify under another', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 2], 0);
    const sig = signLocally(parties, req);
    expect(verify(parties[0].publicKey(1), req.msg, sig)).toBe(false);
  });

  it('rejects a wrong message and tampered signatures', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 3], 2);
    const pk = parties[0].publicKey(2);
    const sig = signLocally(parties, req);
    const tweak = (f: (s: Signature) => void) => {
      const copy = decodeSignature(encodeSignature(sig));
      f(copy);
      return verify(pk, req.msg, copy);
    };
    expect(verify(pk, randomBytes(32), sig)).toBe(false);
    expect(tweak((s) => (s.z[0][0] = (s.z[0][0] + 1) % Q))).toBe(false);
    expect(tweak((s) => (s.h[1][5] = (s.h[1][5] + 1) % Q_W))).toBe(false);
    expect(tweak((s) => (s.c.negative[0] = !s.c.negative[0]))).toBe(false);
    // Huge z (fails the norm check even before the challenge is recomputed).
    expect(tweak((s) => s.z.forEach((p) => p.fill(Math.floor(Q / 2))))).toBe(false);
  });

  it('encodes signatures and public keys at fixed sizes and round-trips them', () => {
    const { parties } = setup(2, 2);
    const req = request([1, 2]);
    const sig = signLocally(parties, req);
    const bytes = encodeSignature(sig);
    expect(bytes.length).toBe(SIGNATURE_BYTES);
    expect(encodeSignature(decodeSignature(bytes))).toEqual(bytes);
    const pk = parties[0].publicKey(0);
    const pkBytes = encodePublicKey(pk);
    expect(pkBytes.length).toBe(PUBLIC_KEY_BYTES);
    expect(verify(decodePublicKey(pkBytes), req.msg, decodeSignature(bytes))).toBe(true);
    expect(pk.t).toHaveLength(K);
    expect(sig.z).toHaveLength(L);
  });
});

describe('protocol guards', () => {
  it('refuses to reuse a session id (it would cancel the PRF masks)', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 2]);
    signLocally(parties, req);
    expect(() => parties[0].round1({ ...req, msg: randomBytes(32) })).toThrow(/reuse/);
  });

  it('rejects active sets of the wrong size or that exclude the party', () => {
    const { parties } = setup(2, 3);
    expect(() => parties[0].round1(request([1]))).toThrow(SigningError);
    expect(() => parties[0].round1(request([1, 2, 3]))).toThrow(SigningError);
    expect(() => parties[0].round1(request([2, 3]))).toThrow(/not in the active set/);
    expect(() => parties[0].round1(request([2, 1]))).toThrow(/strictly increasing/);
  });

  it('detects a party that opens a different commitment', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 2]);
    const [p1, p2] = parties;
    const r1 = [p1.round1(req), p2.round1(req)];
    const r2 = [p1.round2(req.sid, r1), p2.round2(req.sid, r1)];
    r2[1] = { ...r2[1], w: r2[1].w.map((p, i) => (i === 0 ? p.map((x, j) => (j === 0 ? (x + 1) % Q : x)) : p)) };
    expect(() => p1.round3(req.sid, r2)).toThrow(/different commitment/);
  });

  it('detects a split view in round 1 via the pairwise MACs', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 2]);
    const [p1, p2] = parties;
    const r1 = [p1.round1(req), p2.round1(req)];
    // Party 2 is shown a different row blinder for party 1.
    const forged = [{ ...r1[0], mask: r1[0].mask.map((p) => p.map((x) => (x + 1) % Q)) }, r1[1]];
    const r2 = [p1.round2(req.sid, r1), p2.round2(req.sid, forged)];
    expect(() => p1.round3(req.sid, r2)).toThrow(/different round-1 view/);
  });

  it('combine refuses a transcript whose signature does not verify', () => {
    const { parties } = setup(2, 3);
    const req = request([1, 2]);
    const [p1, p2] = parties;
    const r1 = [p1.round1(req), p2.round1(req)];
    const r2 = [p1.round2(req.sid, r1), p2.round2(req.sid, r1)];
    const r3 = [p1.round3(req.sid, r2), p2.round3(req.sid, r2)];
    r3[0] = { ...r3[0], z: r3[0].z.map((p) => p.map((x) => (x + 12345) % Q)) };
    expect(() => combine(p1.publicKey(0), req, r1, r2, r3)).toThrow(/does not verify/);
  });
});
