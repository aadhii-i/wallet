// Signing as it runs over the network: every round message is serialised by
// its sender and parsed by each receiver (no shared objects between parties),
// as in the coordinator-relayed session. (The Go known-answer transcripts are
// written by packages/qd-account/test/write-go-vectors.test.ts.)
import { describe, expect, it } from 'vitest';
import {
  QdParty,
  ROUND1_BYTES,
  ROUND3_BYTES,
  SigningError,
  combine,
  dealerKeyGen,
  decodeRound1,
  decodeRound2,
  decodeRound3,
  decodeSignature,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  encodeSignature,
  round2Bytes,
  verify,
  type KeyShare,
  type SignRequest,
} from '../src';

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

interface Wire {
  r1: Uint8Array[];
  r2: Uint8Array[];
  r3: Uint8Array[];
}

/** Each party only ever sees bytes produced by the others, in act order. */
function runOverWire(shares: KeyShare[], req: SignRequest, tamper?: (round: number, from: number, b: Uint8Array) => Uint8Array): Wire {
  const parties = req.act.map((i) => new QdParty(shares[i - 1]!));
  const t = (round: number, from: number, b: Uint8Array) => (tamper ? tamper(round, from, b) : b);
  const r1 = parties.map((p) => t(1, p.index, encodeRound1(p.round1(req))));
  const r2 = parties.map((p) =>
    t(2, p.index, encodeRound2(p.round2(req.sid, r1.map((b, k) => decodeRound1(req.act[k]!, b))), req.act)),
  );
  const r3 = parties.map((p) =>
    t(3, p.index, encodeRound3(p.round3(req.sid, r2.map((b, k) => decodeRound2(req.act[k]!, b, req.act))))),
  );
  return { r1, r2, r3 };
}

function combineWire(shares: KeyShare[], req: SignRequest, w: Wire) {
  const pk = new QdParty(shares[0]!).publicKey(req.derivationIndex);
  return combine(
    pk,
    req,
    w.r1.map((b, k) => decodeRound1(req.act[k]!, b)),
    w.r2.map((b, k) => decodeRound2(req.act[k]!, b, req.act)),
    w.r3.map((b, k) => decodeRound3(req.act[k]!, b)),
  );
}

function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i <= n; i++) rec(i + 1, [...acc, i]);
  };
  rec(1, []);
  return out;
}

describe('networked signing over serialised round messages', () => {
  const key23 = dealerKeyGen(2, 3).shares;
  const key35 = dealerKeyGen(3, 5).shares;

  it('fixes message sizes', () => {
    expect(ROUND1_BYTES).toBe(32 + 4 * 512 * 7);
    expect(round2Bytes(3)).toBe(5 * 512 * 7 + 2 * 33);
    expect(ROUND3_BYTES).toBe(4 * 512 * 7);
  });

  it('2-of-3: every signer pair produces a signature that verifies under the rerandomised account key', () => {
    for (const act of subsets(3, 2)) {
      const req = { sid: rnd(32), act, derivationIndex: 7, msg: rnd(32) };
      const sig = combineWire(key23, req, runOverWire(key23, req));
      expect(verify(new QdParty(key23[0]!).publicKey(7), req.msg, sig)).toBe(true);
      // Rerandomisation: the account key differs from other indices and the signature is bound to it.
      expect(verify(new QdParty(key23[0]!).publicKey(8), req.msg, sig)).toBe(false);
    }
  }, 60_000);

  it('3-of-5: all ten signer subsets produce valid signatures', () => {
    for (const act of subsets(5, 3)) {
      const req = { sid: rnd(32), act, derivationIndex: 0, msg: rnd(32) };
      const sig = combineWire(key35, req, runOverWire(key35, req));
      expect(verify(new QdParty(key35[2]!).publicKey(0), req.msg, sig)).toBe(true);
      expect(decodeSignature(encodeSignature(sig))).toEqual(sig);
    }
  }, 120_000);

  it('refuses fewer than T signers', () => {
    const req = { sid: rnd(32), act: [1, 2], derivationIndex: 0, msg: rnd(32) };
    expect(() => new QdParty(key35[0]!).round1(req)).toThrow(SigningError);
  });

  it('detects a corrupted commitment (round 1) before any response is released', () => {
    const req = { sid: rnd(32), act: [1, 3, 4], derivationIndex: 0, msg: rnd(32) };
    expect(() =>
      runOverWire(key35, req, (round, from, b) => {
        if (round === 1 && from === 3) {
          const c = b.slice();
          c[0]! ^= 1; // cmt
          return c;
        }
        return b;
      }),
    ).toThrow(/opened a different commitment|altered/);
  });

  it('detects a corrupted commitment share opening (round 2)', () => {
    const req = { sid: rnd(32), act: [2, 4, 5], derivationIndex: 0, msg: rnd(32) };
    expect(() =>
      runOverWire(key35, req, (round, from, b) => {
        if (round === 2 && from === 4) {
          const c = b.slice();
          c[6]! ^= 1; // lowest byte of w's first coefficient
          return c;
        }
        return b;
      }),
    ).toThrow(/opened a different commitment/);
  });

  it('detects a corrupted MAC tag (split view)', () => {
    const req = { sid: rnd(32), act: [1, 2, 3], derivationIndex: 0, msg: rnd(32) };
    expect(() =>
      runOverWire(key35, req, (round, from, b) => {
        if (round === 2 && from === 2) {
          const c = b.slice();
          c[c.length - 1]! ^= 1;
          return c;
        }
        return b;
      }),
    ).toThrow(/different round-1 view/);
  });

  it('a corrupted response share makes combine fail (no invalid signature is ever output)', () => {
    const req = { sid: rnd(32), act: [1, 2], derivationIndex: 0, msg: rnd(32) };
    const w = runOverWire(key23, req, (round, from, b) => {
      if (round === 3 && from === 2) {
        const c = b.slice();
        c[6]! ^= 1;
        return c;
      }
      return b;
    });
    expect(() => combineWire(key23, req, w)).toThrow(/does not verify/);
  });

  it('parties on different session ids cannot complete (transcript binding)', () => {
    const msg = rnd(32);
    const a = new QdParty(key23[0]!);
    const b = new QdParty(key23[1]!);
    const ra = { sid: rnd(32), act: [1, 2], derivationIndex: 0, msg };
    const rb = { ...ra, sid: rnd(32) };
    const r1 = [encodeRound1(a.round1(ra)), encodeRound1(b.round1(rb))];
    const dec = r1.map((x, k) => decodeRound1(k + 1, x));
    const a2 = a.round2(ra.sid, dec);
    const b2 = b.round2(rb.sid, dec);
    expect(() => a.round3(ra.sid, [a2, b2])).toThrow(SigningError);
  });

  it('rejects non-canonical encodings', () => {
    const bad = new Uint8Array(ROUND3_BYTES).fill(0xff);
    expect(() => decodeRound3(1, bad)).toThrow(/out of range/);
    expect(() => decodeRound1(1, new Uint8Array(ROUND1_BYTES - 1))).toThrow(/length/);
    const r2 = new Uint8Array(round2Bytes(2));
    r2[5 * 512 * 7] = 9; // tag addressed to party 9
    expect(() => decodeRound2(1, r2, [1, 2])).toThrow(/wrong party/);
  });
});
