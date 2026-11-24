// Trusted-dealer key generation (QD-Wallet Alg. 1) and key-share serialization.
//
// `reconstructSecret` below is TEST-ONLY: production code never combines
// shares into the master secret. It exists to check that the shares really are
// a degree-(T−1) Shamir sharing of the msk behind the master public key.
import { describe, expect, it } from 'vitest';
import {
  EncodingError,
  K,
  L,
  QdParty,
  dealerKeyGen,
  decodeKeyShare,
  encodeKeyShare,
  keyShareBytes,
  masterKeyFingerprint,
  signLocally,
  verify,
  type KeyShare,
} from '../src';
import { centered, lagrangeAtZero } from '../src/field';
import { addVecQ, matVec, scaleQ, subVecQ, type PolyVec } from '../src/poly';
import { expandA } from '../src/raccoon';

function reconstructSecret(shares: KeyShare[]): PolyVec {
  const act = shares.map((s) => s.index);
  let acc: PolyVec | undefined;
  for (const s of shares) {
    const term = s.share.map((p) => scaleQ(p, lagrangeAtZero(act, s.index)));
    acc = acc ? addVecQ(acc, term) : term;
  }
  return acc!;
}

const maxAbs = (v: PolyVec) => Math.max(...v.flatMap((p) => Array.from(p, (x) => Math.abs(centered(x)))));
/** σ_t = 2^20; a Gaussian sample beyond 2^25 has negligible probability. */
const SHORT = 2 ** 25;

function subsets(n: number, k: number): number[][] {
  if (k === 0) return [[]];
  if (n < k) return [];
  return [...subsets(n - 1, k), ...subsets(n - 1, k - 1).map((s) => [...s, n])];
}

describe.each([
  [2, 3],
  [3, 5],
])('dealerKeyGen(%i, %i)', (t, n) => {
  const out = dealerKeyGen(t, n);
  const A = expandA(out.master.seedA);

  it('produces one share per participant with consistent public data', () => {
    expect(out.shares.map((s) => s.index)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const fp = masterKeyFingerprint(out.shares[0]);
    for (const s of out.shares) {
      expect([s.threshold, s.parties]).toEqual([t, n]);
      expect(masterKeyFingerprint(s)).toEqual(fp);
    }
  });

  it('pairwise seeds match across participants (seed_{i,j} known to i and j only)', () => {
    for (const a of out.shares) {
      for (const b of out.shares) {
        expect(a.seedsOut[b.index - 1]).toEqual(b.seedsIn[a.index - 1]);
      }
    }
  });

  it('every T-subset reconstructs the same short msk with tFull = A·msk + e (test-only)', () => {
    let first: PolyVec | undefined;
    for (const set of subsets(n, t)) {
      const msk = reconstructSecret(set.map((i) => out.shares[i - 1]));
      if (first) expect(subVecQ(msk, first).every((p) => p.every((x) => x === 0))).toBe(true);
      first ??= msk;
    }
    expect(maxAbs(first!)).toBeLessThan(SHORT);
    const e = subVecQ(out.master.tFull, matVec(A, first!));
    expect(e).toHaveLength(K);
    expect(maxAbs(e)).toBeLessThan(SHORT);
  });

  it('T − 1 shares do not reconstruct msk', () => {
    if (t === 1) return;
    const partial = reconstructSecret(out.shares.slice(0, t - 1));
    expect(partial).toHaveLength(L);
    expect(maxAbs(partial)).toBeGreaterThan(SHORT);
  });

  it('shares survive encode/decode and still sign', () => {
    const decoded = out.shares.map((s) => decodeKeyShare(encodeKeyShare(s)));
    for (const [i, d] of decoded.entries()) {
      expect(encodeKeyShare(d)).toEqual(encodeKeyShare(out.shares[i]));
      expect(encodeKeyShare(d)).toHaveLength(keyShareBytes(n));
    }
    const parties = decoded.map((s) => new QdParty(s));
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const act = Array.from({ length: t }, (_, i) => n - t + 1 + i);
    const sig = signLocally(parties, { sid: crypto.getRandomValues(new Uint8Array(32)), act, derivationIndex: 0, msg });
    expect(verify(parties[0].publicKey(0), msg, sig)).toBe(true);
  });
});

describe('key-share encoding rejects malformed input', () => {
  const { shares } = dealerKeyGen(2, 3);
  const good = encodeKeyShare(shares[1]);

  it('rejects truncation, wrong magic, version and parameters', () => {
    expect(() => decodeKeyShare(good.slice(0, -1))).toThrow(EncodingError);
    const cases: [number, number][] = [
      [0, 0x00], // magic
      [4, 2], // version
      [5, 0], // index 0
      [5, 4], // index > N
      [6, 0], // T = 0
      [6, 4], // T > N
      [7, 65], // N > 64
    ];
    for (const [off, val] of cases) {
      const b = good.slice();
      b[off] = val;
      expect(() => decodeKeyShare(b)).toThrow(EncodingError);
    }
  });

  it('rejects a coefficient ≥ q', () => {
    const b = good.slice();
    b.fill(0xff, 8, 15);
    expect(() => decodeKeyShare(b)).toThrow(/out of range/);
  });

  it('rejects inconsistent self seeds', () => {
    const b = good.slice();
    // seedsOut[index−1] for index 2, N = 3
    const off = keyShareBytes(3) - 2 * 3 * 32 + 32;
    b[off] ^= 1;
    expect(() => decodeKeyShare(b)).toThrow(/pairwise seeds/);
  });

  it('fingerprints differ between independent key generations', () => {
    const other = dealerKeyGen(2, 3).shares[1];
    expect(masterKeyFingerprint(other)).not.toEqual(masterKeyFingerprint(shares[1]));
  });
});
