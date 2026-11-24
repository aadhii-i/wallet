import { describe, expect, it } from 'vitest';
import { XWing } from '@hpke/hybridkem-x-wing';
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js';
import { QdParty, dealerKeyGen, decodeKeyShare, encodeKeyShare, masterKeyFingerprint, signLocally, verify } from '@qd/qd-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  QdShareStore,
  ShareProvisioningError,
  XWING_ENC_BYTES,
  coveringActiveSets,
  dealShares,
  envelopeHash,
  generateRecipientKeyPair,
  openFromSender,
  openShareEnvelope,
  sealToRecipient,
  type Kv,
  type ShareContext,
} from '../src';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const WALLET = uuid(1);
const KEYGEN = uuid(2);

function ctx(over: Partial<ShareContext> = {}): ShareContext {
  return {
    walletId: WALLET, keygenId: KEYGEN, participantId: uuid(10), partyIndex: 1, threshold: 2, parties: 3,
    membershipVersion: 3, fingerprint: 'ab'.repeat(32), ...over,
  };
}

async function expectCode(p: Promise<unknown>, code: ShareProvisioningError['code']) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ShareProvisioningError && e.code === code);
}

/** Byte-level search: is `needle` anywhere inside `hay`? */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('X-Wing: hpke-js cross-checked against @noble/post-quantum', () => {
  it('shared secrets agree in both directions, with the same 32-byte seed key format', async () => {
    const kem = new XWing();
    for (let i = 0; i < 5; i++) {
      const nk = ml_kem768_x25519.keygen(crypto.getRandomValues(new Uint8Array(32)));
      const pk = await kem.deserializePublicKey(nk.publicKey);
      const sk = await kem.deserializePrivateKey(nk.secretKey);
      const a = await kem.encap({ recipientPublicKey: pk });
      expect(bytesToHex(ml_kem768_x25519.decapsulate(new Uint8Array(a.enc), nk.secretKey))).toBe(bytesToHex(new Uint8Array(a.sharedSecret)));
      const b = ml_kem768_x25519.encapsulate(nk.publicKey);
      expect(bytesToHex(new Uint8Array(await kem.decap({ enc: b.cipherText, recipientKey: sk })))).toBe(bytesToHex(b.sharedSecret));
    }
  });

  it('a key pair from generateRecipientKeyPair is a valid noble X-Wing key', async () => {
    const kp = await generateRecipientKeyPair();
    expect(ml_kem768_x25519.getPublicKey(kp.privateKey)).toEqual(kp.publicKey);
  });
});

describe('share envelope (HPKE base mode, X-Wing / HKDF-SHA256 / AES-256-GCM)', () => {
  const secret = crypto.getRandomValues(new Uint8Array(1000));

  it('opens only for the intended key and exact context', async () => {
    const me = await generateRecipientKeyPair();
    const other = await generateRecipientKeyPair();
    const env = await sealToRecipient(me.publicKey, ctx(), secret);
    expect(env.enc).toHaveLength(XWING_ENC_BYTES);
    expect(contains(env.ct, secret.slice(0, 32))).toBe(false);
    expect(await openFromSender(me.privateKey, ctx(), env)).toEqual(secret);
    await expectCode(openFromSender(other.privateKey, ctx(), env), 'DECRYPTION_FAILED');

    const variants: Partial<ShareContext>[] = [
      { walletId: uuid(99) }, { keygenId: uuid(99) }, { participantId: uuid(99) }, { partyIndex: 2 },
      { threshold: 3 }, { parties: 4 }, { membershipVersion: 4 }, { fingerprint: 'cd'.repeat(32) },
    ];
    for (const v of variants) await expectCode(openFromSender(me.privateKey, ctx(v), env), 'DECRYPTION_FAILED');
  });

  it('rejects tampering with enc or ct', async () => {
    const me = await generateRecipientKeyPair();
    const env = await sealToRecipient(me.publicKey, ctx(), secret);
    const ct = env.ct.slice();
    ct[10]! ^= 1;
    await expectCode(openFromSender(me.privateKey, ctx(), { enc: env.enc, ct }), 'DECRYPTION_FAILED');
    const enc = env.enc.slice();
    enc[5]! ^= 1;
    await expectCode(openFromSender(me.privateKey, ctx(), { enc, ct: env.ct }), 'DECRYPTION_FAILED');
    await expectCode(openFromSender(me.privateKey, ctx(), { enc: env.enc.slice(1), ct: env.ct }), 'DECRYPTION_FAILED');
  });

  it('refuses malformed contexts and keys before encrypting', async () => {
    const me = await generateRecipientKeyPair();
    await expectCode(sealToRecipient(me.publicKey, ctx({ walletId: 'x|y' }), secret), 'BAD_CONTEXT');
    await expectCode(sealToRecipient(me.publicKey, ctx({ partyIndex: 4 }), secret), 'BAD_CONTEXT');
    await expectCode(sealToRecipient(me.publicKey.slice(1), ctx(), secret), 'BAD_KEY');
  });
});

describe('coveringActiveSets', () => {
  it.each([[1, 1], [1, 3], [2, 3], [3, 5], [5, 10], [32, 64], [6, 11]])('T=%i N=%i covers every party with sorted T-sets', (t, n) => {
    const sets = coveringActiveSets(t, n);
    expect(new Set(sets.flat()).size).toBe(n);
    for (const s of sets) {
      expect(s).toHaveLength(t);
      expect([...s].sort((a, b) => a - b)).toEqual(s);
    }
  });
});

describe.each([
  [2, 3],
  [3, 5],
])('dealShares %i-of-%i: each participant receives exactly their own share', (t, n) => {
  it('provisions, verifies and signs with shares that only their recipients could open', async () => {
    const devices = await Promise.all(Array.from({ length: n }, generateRecipientKeyPair));
    const recipients = devices.map((d, i) => ({ participantId: uuid(100 + i), partyIndex: i + 1, publicKey: d.publicKey }));
    const params = { walletId: WALLET, keygenId: KEYGEN, threshold: t, parties: n, membershipVersion: 7, recipients };
    const dealt = await dealShares(params);

    // The dealer's output carries ciphertexts and a public fingerprint, nothing else.
    expect(Object.keys(dealt).sort()).toEqual(['envelopes', 'fingerprint']);
    for (const e of dealt.envelopes) expect(Object.keys(e).sort()).toEqual(['ct', 'enc', 'participantId', 'partyIndex']);
    expect(new Set(dealt.envelopes.map((e) => bytesToHex(envelopeHash(e)))).size).toBe(n);

    const received = [];
    for (const [i, d] of devices.entries()) {
      const env = dealt.envelopes.find((e) => e.partyIndex === i + 1)!;
      const context = { walletId: WALLET, keygenId: KEYGEN, participantId: uuid(100 + i), partyIndex: i + 1, threshold: t, parties: n, membershipVersion: 7, fingerprint: dealt.fingerprint };
      const bytes = await openShareEnvelope(d.privateKey, context, env);
      const key = decodeKeyShare(bytes);
      expect(key.index).toBe(i + 1);
      expect(bytesToHex(masterKeyFingerprint(key))).toBe(dealt.fingerprint);
      // Another participant's device cannot open this envelope.
      const thief = devices[(i + 1) % n]!;
      await expectCode(openShareEnvelope(thief.privateKey, context, env), 'DECRYPTION_FAILED');
      // Nor can it be redirected to another participant slot.
      await expectCode(openShareEnvelope(d.privateKey, { ...context, partyIndex: ((i + 1) % n) + 1, participantId: uuid(100 + ((i + 1) % n)) }, env), 'DECRYPTION_FAILED');
      received.push(key);
    }

    // In-process only: the independently opened shares sign as one T-of-N key.
    const parties = received.map((k) => new QdParty(k));
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const act = Array.from({ length: t }, (_, i) => n - i).sort((a, b) => a - b);
    const sig = signLocally(parties, { sid: crypto.getRandomValues(new Uint8Array(32)), act, derivationIndex: 3, msg });
    expect(verify(parties[0]!.publicKey(3), msg, sig)).toBe(true);
  });
});

describe('recipient-side verification', () => {
  it('rejects a well-encrypted share that does not match the promised context', async () => {
    const me = await generateRecipientKeyPair();
    const { shares } = dealerKeyGen(2, 3);
    const fp = bytesToHex(masterKeyFingerprint(shares[0]!));
    const base = ctx({ fingerprint: fp });

    // Correct context, but the dealer encrypted share #2 for party #1.
    const wrongIndex = await sealToRecipient(me.publicKey, base, encodeKeyShare(shares[1]!));
    await expectCode(openShareEnvelope(me.privateKey, base, wrongIndex), 'SHARE_MISMATCH');

    // A share from a different key generation under this generation's fingerprint.
    const foreign = dealerKeyGen(2, 3).shares[0]!;
    const env = await sealToRecipient(me.publicKey, base, encodeKeyShare(foreign));
    await expectCode(openShareEnvelope(me.privateKey, base, env), 'SHARE_MISMATCH');

    // Garbage inside a valid envelope.
    const junk = await sealToRecipient(me.publicKey, base, crypto.getRandomValues(new Uint8Array(500)));
    await expectCode(openShareEnvelope(me.privateKey, base, junk), 'SHARE_MISMATCH');

    // The genuine share passes.
    const good = await sealToRecipient(me.publicKey, base, encodeKeyShare(shares[0]!));
    expect(decodeKeyShare(await openShareEnvelope(me.privateKey, base, good)).index).toBe(1);
  });

  it('refuses recipient lists that do not cover 1..N exactly once', async () => {
    const kp = await generateRecipientKeyPair();
    const r = (i: number, idx: number) => ({ participantId: uuid(200 + i), partyIndex: idx, publicKey: kp.publicKey });
    const base = { walletId: WALLET, keygenId: KEYGEN, threshold: 2, parties: 3, membershipVersion: 1 };
    await expectCode(dealShares({ ...base, recipients: [r(1, 1), r(2, 2)] }), 'BAD_CONTEXT');
    await expectCode(dealShares({ ...base, recipients: [r(1, 1), r(2, 2), r(3, 2)] }), 'BAD_CONTEXT');
    await expectCode(dealShares({ ...base, recipients: [r(1, 1), r(1, 2), r(3, 3)] }), 'BAD_CONTEXT');
    await expectCode(dealShares({ ...base, recipients: [r(1, 1), r(2, 2), { ...r(3, 3), publicKey: new Uint8Array(10) }] }), 'BAD_KEY');
  });
});

function memoryKv(): Kv & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: async <T>(k: string) => structuredClone(raw.get(k)) as T | undefined,
    set: async (k: string, v: unknown) => void raw.set(k, structuredClone(v)),
    del: async (k: string) => void raw.delete(k),
  };
}

describe('QdShareStore (encrypted at rest, separate Argon2id salt)', () => {
  const opts = { kdf: { m: 256, t: 1, p: 1 }, allowWeakKdfForTests: true };
  const PW = 'correct horse battery 9!';
  const { shares } = dealerKeyGen(2, 3);
  const shareBytes = encodeKeyShare(shares[0]!);
  const info = { ...ctx({ fingerprint: bytesToHex(masterKeyFingerprint(shares[0]!)) }), storedAt: '2026-11-14T00:00:00Z' };

  it('stores only ciphertext and returns the share to the unlocked owner', async () => {
    const kv = memoryKv();
    const store = new QdShareStore(kv, opts);
    await expectCode(store.putShare(info, shareBytes), 'STORE_LOCKED');
    await store.unlock(PW);
    await store.putShare(info, shareBytes);
    const persisted = new TextEncoder().encode(JSON.stringify([...kv.raw.values()]));
    expect(contains(persisted, shareBytes.slice(8, 40))).toBe(false);
    expect(await store.shareInfo(WALLET)).toEqual(info);
    expect(await store.shareBytes(WALLET)).toEqual(shareBytes);

    store.lock();
    await expectCode(store.shareBytes(WALLET), 'STORE_LOCKED');
    await expectCode(new QdShareStore(kv, opts).unlock('wrong password 123!'), 'STORE_LOCKED');
  });

  it('retains the pinned Bitcoin share through source replacement and password rotation',async()=>{
    const kv=memoryKv(),store=new QdShareStore(kv,opts),id='cd'.repeat(32);
    await store.unlock(PW);await store.putShare(info,shareBytes);
    await store.archiveBitcoinShare(id,WALLET);
    const replacement=encodeKeyShare(dealerKeyGen(2,3).shares[0]!);
    await store.putShare({...info,keygenId:uuid(99)},replacement);
    await store.archiveBitcoinShare(id,WALLET);
    await store.rekey('another strong pass 42!');store.lock();
    const restored=new QdShareStore(kv,opts);await restored.unlock('another strong pass 42!');
    expect(await restored.shareBytes(`bitcoin:${id}`)).toEqual(shareBytes);
    expect((await restored.shareInfo(`bitcoin:${id}`))!.keygenId).toBe(KEYGEN);
    expect(await restored.shareBytes(WALLET)).toEqual(replacement);
  });

  it('detects tampering with the authenticated metadata', async () => {
    const kv = memoryKv();
    const store = new QdShareStore(kv, opts);
    await store.unlock(PW);
    await store.putShare(info, shareBytes);
    const v = kv.raw.get('qdShareStore') as { shares: Record<string, { info: { partyIndex: number } }> };
    v.shares[WALLET]!.info.partyIndex = 2;
    await expectCode(store.shareBytes(WALLET), 'STORE_CORRUPT');
  });

  it('keeps recipient keys per key generation and re-encrypts on password change', async () => {
    const kv = memoryKv();
    const store = new QdShareStore(kv, opts);
    await store.unlock(PW);
    const kp = await generateRecipientKeyPair();
    const rkInfo = { walletId: WALLET, keygenId: KEYGEN, participantId: uuid(10), publicKey: 'pk' };
    await store.putRecipientKey(rkInfo, kp.privateKey);
    await store.putShare(info, shareBytes);
    await store.rekey('another strong pass 42!');
    expect(await store.recipientPrivateKey(KEYGEN)).toEqual(kp.privateKey);

    const reopened = new QdShareStore(kv, opts);
    await expectCode(reopened.unlock(PW), 'STORE_LOCKED');
    await reopened.unlock('another strong pass 42!');
    expect(await reopened.shareBytes(WALLET)).toEqual(shareBytes);
    await reopened.deleteRecipientKey(KEYGEN);
    await expectCode(reopened.recipientPrivateKey(KEYGEN), 'NOT_FOUND');
  });
});
