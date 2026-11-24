// Writes the known-answer signing transcripts used by the Go coordinator
// (services/wallet-api/internal/qdraccoon/testdata) when QD_WRITE_VECTORS=1:
// real 2-of-3 and 3-of-5 runs with every round message serialised as on the wire.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  QdParty,
  combine,
  dealerKeyGen,
  decodeRound1,
  decodeRound2,
  decodeRound3,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  encodeSignature,
} from '@qd/qd-crypto';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'services', 'wallet-api', 'internal', 'qdraccoon', 'testdata');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe.skipIf(!process.env.QD_WRITE_VECTORS)('write Go vectors', () => {
  it('writes 2-of-3 and 3-of-5 transcripts', () => {
    mkdirSync(OUT, { recursive: true });
    for (const [t, n, act] of [[2, 3, [1, 3]], [3, 5, [2, 3, 5]]] as const) {
      const shares = dealerKeyGen(t, n).shares;
      const req = { sid: rnd(32), act: [...act], derivationIndex: 5, msg: rnd(32) };
      const parties = req.act.map((i) => new QdParty(shares[i - 1]!));
      const r1 = parties.map((p) => encodeRound1(p.round1(req)));
      const r2 = parties.map((p) => encodeRound2(p.round2(req.sid, r1.map((b, k) => decodeRound1(req.act[k]!, b))), req.act));
      const r3 = parties.map((p) => encodeRound3(p.round3(req.sid, r2.map((b, k) => decodeRound2(req.act[k]!, b, req.act)))));
      const pk = parties[0]!.publicKey(req.derivationIndex);
      const sig = combine(
        pk, req,
        r1.map((b, k) => decodeRound1(req.act[k]!, b)),
        r2.map((b, k) => decodeRound2(req.act[k]!, b, req.act)),
        r3.map((b, k) => decodeRound3(req.act[k]!, b)),
      );
      writeFileSync(join(OUT, `transcript_${t}of${n}.json`), JSON.stringify({
        threshold: t, parties: n, act: req.act, derivationIndex: req.derivationIndex,
        sid: b64(req.sid), msg: b64(req.msg), publicKey: b64(encodePublicKey(pk)),
        round1: r1.map(b64), round2: r2.map(b64), round3: r3.map(b64), signature: b64(encodeSignature(sig)),
      }) + '\n');
    }
  }, 60_000);
});
