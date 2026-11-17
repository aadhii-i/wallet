// Key generation + share provisioning over HTTP against a real wallet-api,
// with real cryptography: dealerKeyGen, HPKE X-Wing envelopes, recipient
// verification and the encrypted share store. Runs only when QD_API_URL is set:
//   (cd services/wallet-api && HTTP_ADDR=:8181 METRICS_ADDR=:9191 APP_ENV=development STORE=memory \
//      PRICE_PROVIDER=static DEV_CREDENTIAL_RATE_BURST=200 go run ./cmd/wallet-api) &
//   QD_API_URL=http://localhost:8181 npx vitest run test/shared-keygen.integration.test.ts
//
// Each participant is an independent user (own device key, own session, own
// share store). Their shares are only ever combined below in an in-process
// signing check, which stands in for the not-yet-implemented networked session.
import { describe, expect, it } from 'vitest';
import { QdParty, decodeKeyShare, signLocally, verify } from '@qd/qd-crypto';
import {
  QdShareStore,
  ShareProvisioningError,
  dealShares,
  generateRecipientKeyPair,
  openShareEnvelope,
  type Kv,
} from '@qd/wallet-core';
import {
  ApiClient,
  ApiError,
  checkKeygenAgainstWallet,
  fromB64url,
  generateDeviceKeyPair,
  keygenSafetyNumber,
  toB64url,
  webCryptoDeviceKey,
  type KeyGeneration,
  type MyEnvelope,
} from '../src';

const API = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.QD_API_URL;
const PASSWORD = 'integration test pw 1!';

function memoryKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    del: async (k: string) => void m.delete(k),
  };
}

interface Device {
  api: ApiClient;
  shares: QdShareStore;
}

async function newDevice(): Promise<Device> {
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  const api = new ApiClient({
    baseUrl: API!, clientType: 'mobile', platform: 'android', expectedOrigin: 'app:qdwallet',
    deviceKey: webCryptoDeviceKey(await generateDeviceKeyPair()), freshDevice: true,
    tokenStore: { get: async () => tokens, set: async (t) => void (tokens = t) },
  });
  const shares = new QdShareStore(memoryKv(), { kdf: { m: 256, t: 1, p: 1 }, allowWeakKdfForTests: true });
  await shares.unlock(PASSWORD);
  return { api, shares };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

async function walletOf(n: number) {
  const devices = await Promise.all(Array.from({ length: n }, newDevice));
  const owner = devices[0]!;
  const w = await owner.api.createSharedWallet('Keygen test', 'P1');
  for (const [i, d] of devices.slice(1).entries()) {
    await d.api.acceptInvitation((await owner.api.createInvitation(w.id, `P${i + 2}`)).code, `P${i + 2}`);
  }
  return { walletId: w.id, devices, owner };
}

/** What the key worker does on a participant's device: fresh X-Wing key, kept encrypted locally. */
async function registerKey(d: Device, walletId: string): Promise<KeyGeneration> {
  const kg = await d.api.currentKeyGeneration(walletId);
  checkKeygenAgainstWallet(await d.api.sharedWallet(walletId), kg);
  const kp = await generateRecipientKeyPair();
  await d.shares.putRecipientKey({ walletId, keygenId: kg.id, participantId: kg.me!.participantId, publicKey: toB64url(kp.publicKey) }, kp.privateKey);
  return d.api.registerEncryptionKey(walletId, kg, kp.publicKey);
}

async function deal(owner: Device, walletId: string) {
  const kg = await owner.api.currentKeyGeneration(walletId);
  checkKeygenAgainstWallet(await owner.api.sharedWallet(walletId), kg);
  const dealt = await dealShares({
    walletId, keygenId: kg.id, threshold: kg.threshold, parties: kg.parties, membershipVersion: kg.membershipVersion,
    recipients: kg.participants.map((p) => ({ participantId: p.participantId, partyIndex: p.partyIndex, publicKey: fromB64url(p.encryptionKey!) })),
  });
  await owner.api.uploadDeal(walletId, kg, dealt.fingerprint, dealt.envelopes);
  return dealt;
}

function contextOf(e: MyEnvelope) {
  return {
    walletId: e.walletId, keygenId: e.keygenId, participantId: e.participantId, partyIndex: e.partyIndex,
    threshold: e.threshold, parties: e.parties, membershipVersion: e.membershipVersion, fingerprint: e.fingerprint,
  };
}

/** Download, decrypt, verify, store encrypted, then acknowledge. */
async function receive(d: Device, walletId: string) {
  const kg = await d.api.currentKeyGeneration(walletId);
  const env = await d.api.myKeygenEnvelope(walletId, kg.id);
  const sk = await d.shares.recipientPrivateKey(kg.id);
  const bytes = await openShareEnvelope(sk, contextOf(env), { enc: fromB64url(env.enc), ct: fromB64url(env.ct) });
  await d.shares.putShare({ ...contextOf(env), storedAt: new Date().toISOString() }, bytes);
  await d.shares.deleteRecipientKey(kg.id);
  return d.api.acknowledgeShare(walletId, env);
}

describe.skipIf(!API)('shared-wallet key generation over HTTP (5 independent users, real crypto)', () => {
  it('provisions a 3-of-5 Threshold Raccoon key and initializes the wallet only after all acknowledge', async () => {
    const { walletId, devices, owner } = await walletOf(5);
    const outsider = await newDevice();
    expect((await owner.api.sharedWallet(walletId)).key.status).toBe('not_initialized');
    expect(await code(devices[1]!.api.startKeyGeneration(walletId))).toBe('FORBIDDEN');

    const started = await owner.api.startKeyGeneration(walletId);
    expect(started).toMatchObject({ threshold: 3, parties: 5, status: 'collecting_keys' });
    expect((await devices[2]!.api.sharedWallet(walletId)).key.status).toBe('in_progress');

    for (const d of devices) await registerKey(d, walletId);
    const views = await Promise.all(devices.map((d) => d.api.currentKeyGeneration(walletId)));
    const numbers = await Promise.all(views.map((v) => keygenSafetyNumber(walletId, v)));
    expect(new Set(numbers).size).toBe(1); // everyone sees the same key set
    expect(numbers[0]).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(views[0]!.status).toBe('dealing');

    const dealt = await deal(owner, walletId);
    expect((await devices[3]!.api.sharedWallet(walletId)).key.status).toBe('awaiting_provisioning');
    expect(await code(outsider.api.myKeygenEnvelope(walletId, started.id))).toBe('NOT_FOUND');

    for (const [i, d] of devices.entries()) {
      // Another participant's device cannot open this participant's envelope.
      if (i === 1) {
        const env = await d.api.myKeygenEnvelope(walletId, started.id);
        const thiefKey = await devices[2]!.shares.recipientPrivateKey(started.id);
        await expect(openShareEnvelope(thiefKey, contextOf(env), { enc: fromB64url(env.enc), ct: fromB64url(env.ct) }))
          .rejects.toBeInstanceOf(ShareProvisioningError);
      }
      const after = await receive(d, walletId);
      const w = await owner.api.sharedWallet(walletId);
      if (i < devices.length - 1) {
        expect(w.key.status).toBe('awaiting_provisioning');
        expect(after.provisioned).toBe(i + 1);
      } else {
        expect(w.key).toMatchObject({ status: 'initialized', fingerprint: dealt.fingerprint, keyGenerationId: started.id });
      }
    }
    expect(await code(devices[1]!.api.myKeygenEnvelope(walletId, started.id))).toBe('ALREADY_PROVISIONED');
    expect(await code(owner.api.startKeyGeneration(walletId))).toBe('KEY_ALREADY_INITIALIZED');

    // Each device holds exactly one share: its own index, the agreed fingerprint.
    const keys = await Promise.all(devices.map(async (d, i) => {
      const info = await d.shares.shareInfo(walletId);
      expect(info).toMatchObject({ partyIndex: i + 1, fingerprint: dealt.fingerprint, threshold: 3, parties: 5 });
      return decodeKeyShare(await d.shares.shareBytes(walletId));
    }));

    // Approvals: the signing job now refers to an initialized key, but no signature exists.
    const acct = await owner.api.createSharedAccount(walletId, 'Ops');
    const prop = await owner.api.createProposal(walletId, {
      accountId: acct.id, chainId: 31337, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', valueWei: '1',
      nonce: 0, gasLimit: 21000, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
    });
    for (const i of [4, 1, 2]) await devices[i]!.api.voteOnProposal(prop.id, 'approve');
    const approved = await owner.api.proposal(prop.id);
    expect(approved.signing).toMatchObject({ status: 'awaiting_signing_session', signerPartyIndexes: [2, 3, 5] });
    expect(approved.execution.status).toBe('unavailable');

    // In-process only (stand-in for the future networked session): the shares
    // that arrived on separate devices sign the approved proposal digest.
    const act = approved.signing!.signerPartyIndexes!;
    const digest = Uint8Array.from(approved.digest.match(/../g)!.map((h) => parseInt(h, 16)));
    const parties = act.map((i) => new QdParty(keys[i - 1]!));
    const sig = signLocally(parties, { sid: crypto.getRandomValues(new Uint8Array(32)), act, derivationIndex: approved.derivationIndex, msg: digest });
    expect(verify(parties[0]!.publicKey(approved.derivationIndex), digest, sig)).toBe(true);
  }, 120_000);

  it('a participant who cannot verify its share fails the ceremony; a retry succeeds; revocation requires a rekey', async () => {
    const { walletId, devices, owner } = await walletOf(3);
    const first = await owner.api.startKeyGeneration(walletId);
    for (const d of devices) await registerKey(d, walletId);
    await deal(owner, walletId);
    await receive(devices[0]!, walletId);

    // Participant 2's envelope is corrupted in transit (simulated after download).
    const env = await devices[1]!.api.myKeygenEnvelope(walletId, first.id);
    const ct = fromB64url(env.ct);
    ct[100]! ^= 1;
    const sk = await devices[1]!.shares.recipientPrivateKey(first.id);
    await expect(openShareEnvelope(sk, contextOf(env), { enc: fromB64url(env.enc), ct })).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    await devices[1]!.api.failKeyGeneration(walletId, first.id, 'decryption_failed');
    expect((await owner.api.sharedWallet(walletId)).key.status).toBe('failed');
    expect(await code(receive(devices[2]!, walletId))).toBe('KEYGEN_NOT_OPEN');

    // Retry from scratch: new ceremony, new keys, new shares.
    await owner.api.startKeyGeneration(walletId);
    for (const d of devices) await registerKey(d, walletId);
    const dealt = await deal(owner, walletId);
    for (const d of devices) await receive(d, walletId);
    expect((await devices[2]!.api.sharedWallet(walletId)).key).toMatchObject({ status: 'initialized', fingerprint: dealt.fingerprint });
    // The share stored from the failed ceremony was replaced.
    expect((await devices[0]!.shares.shareInfo(walletId))!.fingerprint).toBe(dealt.fingerprint);

    // Revoking a participant makes the key stale: a new 2-of-2 ceremony is needed.
    const target = (await devices[2]!.api.sharedWallet(walletId)).me.id;
    await owner.api.revokeParticipant(walletId, target);
    expect((await owner.api.sharedWallet(walletId)).key.status).toBe('rekey_required');
    const rekey = await owner.api.startKeyGeneration(walletId);
    expect(rekey).toMatchObject({ parties: 2, threshold: 1 });
    expect(rekey.participants.map((p) => p.participantId)).not.toContain(target);
  }, 120_000);
});
