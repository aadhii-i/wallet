import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { lagrangeAtZero } from './field';
import { K, L, MSG_BYTES, N, NU_W, Q_W, SEED_BYTES, sigmaW } from './params';
import {
  addVecQ,
  mulNtt,
  matVec,
  roundPoly,
  scaleQ,
  subVecQ,
  toNtt,
  type PolyVec,
} from './poly';
import {
  challenge,
  challengePoly,
  commitmentFromResponse,
  expandA,
  hint,
  publicKeyHash,
  verify,
  type PublicKey,
  type Signature,
} from './raccoon';
import { accountPublicKey, deriveShare, type KeyShare } from './keys';
import { Xof, gaussianVec, u32be } from './sample';

/**
 * Inputs every party in `act` must agree on before round 1.
 *
 * `sid` identifies this signing run and must never repeat. It keys the PRF
 * masks, and reusing it would cancel them across two signatures.
 * `derivationIndex` picks the account key. The two are deliberately separate
 * (README §2.2).
 */
export interface SignRequest {
  sid: Uint8Array;
  act: number[];
  derivationIndex: number;
  msg: Uint8Array;
}

export interface Round1Msg {
  from: number;
  cmt: Uint8Array;
  /** Row blinder m_j = Σ_{i∈act} PRF(seed_{j,i}, sid). */
  mask: PolyVec;
}

export interface Round2Msg {
  from: number;
  /** Unrounded commitment share w_j = A·r_j + e_j. */
  w: PolyVec;
  /** MAC over the round-1 view, one per other active party. */
  tags: { to: number; tag: Uint8Array }[];
}

export interface Round3Msg {
  from: number;
  z: PolyVec;
}

export class SigningError extends Error {
  constructor(message: string) {
    super(`qd-crypto: ${message}`);
    this.name = 'SigningError';
  }
}

// ---------------------------------------------------------------------------
// Hash helpers (SHA3-256; these never need to be recomputed on chain)
// ---------------------------------------------------------------------------

const te = new TextEncoder();

/** Constant-time comparison for tags and commitments. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function h(domain: string, ...parts: Uint8Array[]): Uint8Array {
  return sha3_256(concatBytes(te.encode(domain), ...parts));
}

/** Big-endian 7 bytes per coefficient; for polynomials mod q. */
export function encodeQVec(v: PolyVec): Uint8Array {
  const out = new Uint8Array(v.length * N * 7);
  let o = 0;
  for (const p of v) {
    for (let i = 0; i < N; i++) {
      let x = p[i];
      for (let b = 6; b >= 0; b--) {
        out[o + b] = x % 256;
        x = Math.floor(x / 256);
      }
      o += 7;
    }
  }
  return out;
}

function actBytes(act: number[]): Uint8Array {
  return new Uint8Array(act);
}

function context(req: SignRequest): Uint8Array {
  return concatBytes(req.sid, actBytes(req.act), req.msg, u32be(req.derivationIndex));
}

function commitmentHash(req: SignRequest, from: number, w: PolyVec): Uint8Array {
  return h('QD-cmt', context(req), new Uint8Array([from]), encodeQVec(w));
}

function round1Digest(req: SignRequest, r1: Round1Msg[]): Uint8Array {
  return h(
    'QD-C1',
    context(req),
    ...r1.flatMap((m) => [new Uint8Array([m.from]), m.cmt, encodeQVec(m.mask)]),
  );
}

function prfVec(seed: Uint8Array, sid: Uint8Array): PolyVec {
  const xof = new Xof('QD-PRF', seed, sid);
  return Array.from({ length: L }, () => xof.uniformPoly());
}

function sumVecs(vs: PolyVec[], len: number): PolyVec {
  let acc: PolyVec = Array.from({ length: len }, () => new Float64Array(N));
  for (const v of vs) acc = addVecQ(acc, v);
  return acc;
}

/** Pairwise MAC key; both endpoints know seed_{i,j} and seed_{j,i}. */
function macKey(key: KeyShare, other: number): Uint8Array {
  const out = key.seedsOut[other - 1];
  const inn = key.seedsIn[other - 1];
  const [lo, hi] = key.index < other ? [out, inn] : [inn, out];
  return h('QD-MACKEY', lo, hi);
}

function macTag(k: Uint8Array, digest: Uint8Array, from: number, to: number): Uint8Array {
  return h('QD-R2', k, digest, new Uint8Array([from, to]));
}

function aggregateCommitment(r2: Round2Msg[]): PolyVec {
  return sumVecs(
    r2.map((m) => m.w),
    K,
  ).map((p) => roundPoly(p, NU_W, Q_W));
}

function byIndex<T extends { from: number }>(msgs: T[], act: number[], round: string): T[] {
  if (msgs.length !== act.length) throw new SigningError(`${round}: expected ${act.length} messages`);
  return act.map((i) => {
    const found = msgs.filter((m) => m.from === i);
    if (found.length !== 1) throw new SigningError(`${round}: missing or duplicate message from party ${i}`);
    return found[0];
  });
}

function checkVec(v: PolyVec, len: number, bound: number, what: string): void {
  const ok =
    v.length === len &&
    v.every((p) => p.length === N && p.every((x) => Number.isInteger(x) && x >= 0 && x < bound));
  if (!ok) throw new SigningError(`malformed ${what}`);
}

// ---------------------------------------------------------------------------
// Party state machine: TRaccoon ShareSign1/2/3 with QD rerandomised shares
// (QD-Wallet Alg. 4)
// ---------------------------------------------------------------------------

interface Session {
  req: SignRequest;
  pk: PublicKey;
  stage: 1 | 2;
  r?: PolyVec;
  w: PolyVec;
  r1?: Round1Msg[];
  digest?: Uint8Array;
}

export class QdParty {
  private readonly usedSids = new Set<string>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly key: KeyShare) {}

  get index(): number {
    return this.key.index;
  }

  publicKey(derivationIndex: number): PublicKey {
    return accountPublicKey(this.key, derivationIndex);
  }

  /** ShareSign1: sample (r_j, e_j), commit to w_j, publish the row blinder. */
  round1(req: SignRequest): Round1Msg {
    this.validateRequest(req);
    const sidHex = bytesToHex(req.sid);
    if (this.usedSids.has(sidHex)) throw new SigningError('session id reuse refused');
    this.usedSids.add(sidHex);

    const pk = this.publicKey(req.derivationIndex);
    const sigma = sigmaW(this.key.threshold);
    const r = gaussianVec(L, sigma);
    const e = gaussianVec(K, sigma);
    const w = addVecQ(matVec(expandA(pk.seedA), r), e);
    const cmt = commitmentHash(req, this.key.index, w);
    const mask = sumVecs(
      req.act.map((i) => prfVec(this.key.seedsOut[i - 1], req.sid)),
      L,
    );
    this.sessions.set(sidHex, { req: cloneRequest(req), pk, stage: 1, r, w });
    return { from: this.key.index, cmt, mask };
  }

  /** ShareSign2: reveal w_j and authenticate the round-1 view. */
  round2(sid: Uint8Array, r1: Round1Msg[]): Round2Msg {
    const s = this.session(sid, 1);
    const ordered = byIndex(r1, s.req.act, 'round 1');
    for (const m of ordered) {
      if (m.cmt.length !== 32) throw new SigningError('malformed commitment');
      checkVec(m.mask, L, Infinity, 'row blinder');
    }
    const own = ordered.find((m) => m.from === this.key.index)!;
    if (!equalBytes(own.cmt, commitmentHash(s.req, this.key.index, s.w))) {
      throw new SigningError('own round-1 message was altered');
    }
    const digest = round1Digest(s.req, ordered);
    const tags = s.req.act
      .filter((i) => i !== this.key.index)
      .map((to) => ({ to, tag: macTag(macKey(this.key, to), digest, this.key.index, to) }));
    s.r1 = ordered;
    s.digest = digest;
    s.stage = 2;
    return { from: this.key.index, w: s.w, tags };
  }

  /** ShareSign3: check the reveals, then publish the masked response share. */
  round3(sid: Uint8Array, r2: Round2Msg[]): Round3Msg {
    const s = this.session(sid, 2);
    const ordered = byIndex(r2, s.req.act, 'round 2');
    ordered.forEach((m, pos) => {
      checkVec(m.w, K, Infinity, 'commitment share');
      if (!equalBytes(s.r1![pos].cmt, commitmentHash(s.req, m.from, m.w))) {
        throw new SigningError(`party ${m.from} opened a different commitment`);
      }
      if (m.from === this.key.index) return;
      const tag = m.tags.find((t) => t.to === this.key.index)?.tag;
      const expected = macTag(macKey(this.key, m.from), s.digest!, m.from, this.key.index);
      if (!tag || !equalBytes(tag, expected)) {
        throw new SigningError(`party ${m.from} saw a different round-1 view`);
      }
    });

    const w = aggregateCommitment(ordered);
    const c = challenge(publicKeyHash(s.pk), s.req.msg, w);
    const lambda = lagrangeAtZero(s.req.act, this.key.index);
    const share = deriveShare(this.key, s.req.derivationIndex);
    const cHat = toNtt(challengePoly(c));
    const cs = share.map((p) => mulNtt(cHat, toNtt(scaleQ(p, lambda))));
    const colMask = sumVecs(
      s.req.act.map((i) => prfVec(this.key.seedsIn[i - 1], s.req.sid)),
      L,
    );
    const z = addVecQ(addVecQ(cs, s.r!), colMask);

    // r_j is single-use. Forget the session before releasing z_j.
    delete s.r;
    this.sessions.delete(bytesToHex(sid));
    return { from: this.key.index, z };
  }

  private session(sid: Uint8Array, stage: 1 | 2): Session {
    const s = this.sessions.get(bytesToHex(sid));
    if (!s || s.stage !== stage) throw new SigningError(`no session in stage ${stage} for this sid`);
    return s;
  }

  private validateRequest(req: SignRequest): void {
    const { act } = req;
    if (req.sid.length !== SEED_BYTES) throw new SigningError('sid must be 32 bytes');
    if (req.msg.length !== MSG_BYTES) throw new SigningError('message must be a 32-byte digest');
    if (act.length !== this.key.threshold) {
      throw new SigningError(`active set must have exactly T = ${this.key.threshold} parties`);
    }
    const sorted = act.every((v, i) => Number.isInteger(v) && v >= 1 && v <= this.key.parties && (i === 0 || v > act[i - 1]));
    if (!sorted) throw new SigningError('active set must be strictly increasing party indices');
    if (!act.includes(this.key.index)) throw new SigningError('this party is not in the active set');
  }
}

function cloneRequest(req: SignRequest): SignRequest {
  return { sid: req.sid.slice(), act: [...req.act], derivationIndex: req.derivationIndex, msg: req.msg.slice() };
}

// ---------------------------------------------------------------------------
// Combine (public; anyone holding the transcript can run it)
// ---------------------------------------------------------------------------

export function combine(
  pk: PublicKey,
  req: SignRequest,
  r1: Round1Msg[],
  r2: Round2Msg[],
  r3: Round3Msg[],
): Signature {
  const o1 = byIndex(r1, req.act, 'round 1');
  const o2 = byIndex(r2, req.act, 'round 2');
  const o3 = byIndex(r3, req.act, 'round 3');
  o3.forEach((m) => checkVec(m.z, L, Infinity, 'response share'));

  const w = aggregateCommitment(o2);
  const z = subVecQ(
    sumVecs(o3.map((m) => m.z), L),
    sumVecs(o1.map((m) => m.mask), L),
  );
  const c = challenge(publicKeyHash(pk), req.msg, w);
  const y = commitmentFromResponse(pk, c, z);
  const sig: Signature = { c, z, h: hint(w, y) };
  if (!verify(pk, req.msg, sig)) throw new SigningError('combined signature does not verify');
  return sig;
}

/** Runs every round in-process. For tests, benchmarks and the dealer's self-check. */
export function signLocally(parties: QdParty[], req: SignRequest): Signature {
  const active = req.act.map((i) => {
    const p = parties.find((x) => x.index === i);
    if (!p) throw new SigningError(`party ${i} not available`);
    return p;
  });
  const r1 = active.map((p) => p.round1(req));
  const r2 = active.map((p) => p.round2(req.sid, r1));
  const r3 = active.map((p) => p.round3(req.sid, r2));
  return combine(active[0].publicKey(req.derivationIndex), req, r1, r2, r3);
}
