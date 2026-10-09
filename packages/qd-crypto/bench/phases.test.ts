import { it } from 'vitest';
import {
  NORM_BOUND,
  QdParty,
  combine,
  dealerKeyGen,
  derivePublicKey,
  deriveShare,
  signatureSqNorm,
  verify,
  type SignRequest,
} from '../src';
import { randomBytes } from '../src/sample';

/**
 * Wall-clock latency per phase, mirroring Table 3 of the QD-Wallet paper
 * (full-consensus T = N; ShareSign_i is per signer). Run: `pnpm bench`.
 */
declare const process: { env: Record<string, string | undefined> };

const THRESHOLDS = (process.env.QD_BENCH_T ?? '2,3,4,16,64').split(',').map(Number);
const TRIALS = Number(process.env.QD_BENCH_TRIALS ?? 4);

function time<T>(f: () => T): [T, number] {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const fmt = (xs: number[]) => `${mean(xs).toFixed(2)}±${sd(xs).toFixed(2)}`;

it('QD-Wallet phase latency (ms)', () => {
  const rows: string[] = [];
  const cols = ['KeyGen', 'RandSK', 'RandPK', 'SS1', 'SS2', 'SS3', 'Combine', 'Verify'] as const;
  for (const T of THRESHOLDS) {
    const m: Record<(typeof cols)[number], number[]> = Object.fromEntries(cols.map((c) => [c, []])) as never;
    let worst = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const [dealer, tk] = time(() => dealerKeyGen(T, T));
      m.KeyGen.push(tk);
      const idx = trial + 1;
      m.RandSK.push(time(() => deriveShare(dealer.shares[0], idx))[1]);
      const [pk, tp] = time(() => derivePublicKey(dealer.master, dealer.chaincode, idx));
      m.RandPK.push(tp);

      const parties = dealer.shares.map((k) => new QdParty(k));
      const act = parties.map((p) => p.index);
      const req: SignRequest = { sid: randomBytes(32), act, derivationIndex: idx, msg: randomBytes(32) };
      const per = (f: (p: QdParty) => unknown) => {
        const out = parties.map((p) => time(() => f(p)));
        return [out.map((o) => o[0]), mean(out.map((o) => o[1]))] as const;
      };
      const [r1, t1] = per((p) => p.round1(req));
      const [r2, t2] = per((p) => p.round2(req.sid, r1 as never));
      const [r3, t3] = per((p) => p.round3(req.sid, r2 as never));
      m.SS1.push(t1);
      m.SS2.push(t2);
      m.SS3.push(t3);
      const [sig, tc] = time(() => combine(pk, req, r1 as never, r2 as never, r3 as never));
      m.Combine.push(tc);
      const [ok, tv] = time(() => verify(pk, req.msg, sig));
      if (!ok) throw new Error('verification failed');
      m.Verify.push(tv);
      worst = Math.max(worst, Math.sqrt(signatureSqNorm(sig)) / NORM_BOUND);
    }
    rows.push(`| ${T} | ${cols.map((c) => fmt(m[c])).join(' | ')} | ${worst.toFixed(3)} |`);
  }
  console.log(
    [
      `| T | ${cols.join(' | ')} | max ‖σ‖/B |`,
      `|---|${cols.map(() => '---').join('|')}|---|`,
      ...rows,
    ].join('\n'),
  );
});
