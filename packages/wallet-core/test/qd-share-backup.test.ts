import { describe, expect, it } from 'vitest';
import { QdParty, dealerKeyGen, decodeKeyShare, encodeKeyShare, masterKeyFingerprint, signLocally, verify } from '@qd/qd-crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MAX_SHARE_BACKUP_BYTES,
  QdShareStore,
  type Kv,
  ShareProvisioningError,
  VaultError,
  assertBackupIsFor,
  decryptShareBackup,
  encryptShareBackup,
  fromBase64Url,
  toBase64Url,
  parseShareBackup,
  type ShareBackupFile,
  type ShareContext,
} from '../src';

const uuid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const opts = { kdf: { m: 256, t: 1, p: 1 }, allowWeakKdfForTests: true };
const PASSWORD = 'correct horse battery staple 42!';

const dealt = dealerKeyGen(2, 3);
const fingerprint = bytesToHex(masterKeyFingerprint(dealt.shares[0]!));
const encoded = dealt.shares.map(encodeKeyShare);

function ctx(partyIndex = 2, over: Partial<ShareContext> = {}): ShareContext {
  return {
    walletId: uuid(1), keygenId: uuid(2), participantId: uuid(10 + partyIndex), partyIndex, threshold: 2, parties: 3,
    membershipVersion: 4, fingerprint, ...over,
  };
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await expect(run).rejects.toSatisfy((e: unknown) => (e instanceof ShareProvisioningError || e instanceof VaultError) && e.code === code);
}

const roundTrip = async (f: ShareBackupFile) => parseShareBackup(JSON.stringify(f));

describe('share backup files', () => {
  it('round-trips a share, and the restored share still signs with the others', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    const { share, context } = await decryptShareBackup(await roundTrip(file), PASSWORD, opts);
    expect(context).toEqual(ctx(2));
    expect(share).toEqual(encoded[1]);

    const parties = [new QdParty(decodeKeyShare(encoded[0]!)), new QdParty(decodeKeyShare(share))];
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const sig = signLocally(parties, { sid: crypto.getRandomValues(new Uint8Array(32)), act: [1, 2], derivationIndex: 0, msg });
    expect(verify(parties[0]!.publicKey(0), msg, sig)).toBe(true);
  });

  it('contains only public metadata in the clear, never the share', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    const text = JSON.stringify(file);
    expect(text).not.toContain(PASSWORD);
    expect(Object.keys(file).sort()).toEqual(['cipher', 'context', 'createdAt', 'ct', 'format', 'kdf', 'key', 'v']);
    // The share is about as long as the ciphertext; a plaintext slice must not appear.
    const b64 = toBase64Url(encoded[1]!.slice(0, 48));
    expect(text).not.toContain(b64);
  });

  it('uses the wallet KDF by default and refuses weak passwords', async () => {
    await expectCode(encryptShareBackup(ctx(2), encoded[1]!, 'short', opts), 'WEAK_PASSWORD');
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, { kdf: { m: 19456, t: 2, p: 1 } });
    expect(file.kdf).toMatchObject({ alg: 'argon2id', m: 19456, t: 2, p: 1 });
  });

  it('a wrong password fails without revealing anything', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    await expectCode(decryptShareBackup(file, `${PASSWORD}x`, opts), 'BACKUP_WRONG_PASSWORD');
  });

  it('detects any edit to the header or ciphertext', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    const edits: ((f: ShareBackupFile) => void)[] = [
      (f) => (f.context.walletId = uuid(99)),
      (f) => (f.context.keygenId = uuid(98)),
      (f) => (f.context.participantId = uuid(97)),
      (f) => (f.context.membershipVersion = 5),
      (f) => (f.context.threshold = 3),
      (f) => (f.kdf.t = 2),
      (f) => (f.kdf.salt = toBase64Url(new Uint8Array(16))),
      (f) => (f.cipher.iv = toBase64Url(new Uint8Array(12))),
      (f) => {
        const ct = fromBase64Url(f.ct);
        ct[10]! ^= 1;
        f.ct = toBase64Url(ct);
      },
    ];
    for (const edit of edits) {
      const f = structuredClone(file);
      edit(f);
      await expectCode(decryptShareBackup(await roundTrip(f), PASSWORD, opts), 'BACKUP_WRONG_PASSWORD');
    }
  });

  it('refuses a share that does not match its claimed context, even with a consistent header', async () => {
    // Party 1's share labelled as party 2, encrypted honestly: decrypts, then fails the share check.
    const file = await encryptShareBackup(ctx(2), encoded[0]!, PASSWORD, opts);
    await expectCode(decryptShareBackup(file, PASSWORD, opts), 'SHARE_MISMATCH');
    const other = dealerKeyGen(2, 3);
    const foreign = await encryptShareBackup(ctx(2), encodeKeyShare(other.shares[1]!), PASSWORD, opts);
    await expectCode(decryptShareBackup(foreign, PASSWORD, opts), 'SHARE_MISMATCH');
  });

  it('rejects malformed files, oversized files and KDF downgrades or bombs', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    for (const text of ['', 'not json', 'null', '[]', '{}', JSON.stringify({ ...file, format: 'other' }), JSON.stringify({ ...file, v: 2 }),
      JSON.stringify({ ...file, context: { ...file.context, partyIndex: 4 } }), JSON.stringify({ ...file, kdf: { ...file.kdf, alg: 'scrypt' } })]) {
      await expectCode(() => parseShareBackup(text), 'BACKUP_INVALID');
    }
    await expectCode(() => parseShareBackup(' '.repeat(MAX_SHARE_BACKUP_BYTES + 1)), 'BACKUP_INVALID');
    // Weak parameters are refused outside tests; huge ones always.
    await expectCode(decryptShareBackup(file, PASSWORD), 'BACKUP_INVALID');
    await expectCode(decryptShareBackup({ ...file, kdf: { ...file.kdf, m: 1 << 30 } }, PASSWORD, opts), 'BACKUP_INVALID');
    await expectCode(decryptShareBackup({ ...file, ct: 'AA' }, PASSWORD, opts), 'BACKUP_INVALID');
  });

  it('is accepted only for the same wallet, current key and participant', async () => {
    const file = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
    const expected = { walletId: uuid(1), keygenId: uuid(2), participantId: uuid(12), partyIndex: 2, fingerprint };
    expect(() => assertBackupIsFor(file, expected)).not.toThrow();
    await expectCode(() => assertBackupIsFor(file, { ...expected, walletId: uuid(5) }), 'BACKUP_WRONG_KEY');
    await expectCode(() => assertBackupIsFor(file, { ...expected, keygenId: uuid(6) }), 'BACKUP_WRONG_KEY');
    await expectCode(() => assertBackupIsFor(file, { ...expected, fingerprint: 'cd'.repeat(32) }), 'BACKUP_WRONG_KEY');
    await expectCode(() => assertBackupIsFor(file, { ...expected, participantId: uuid(11) }), 'BACKUP_WRONG_KEY');
    await expectCode(() => assertBackupIsFor(file, { ...expected, partyIndex: 1 }), 'BACKUP_WRONG_KEY');
  });

  describe('automatic backups that open with the wallet password', () => {
    function memoryKv(): Kv {
      const m = new Map<string, unknown>();
      return {
        get: async <T,>(k: string) => structuredClone(m.get(k)) as T | undefined,
        set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
        del: async (k: string) => void m.delete(k),
      };
    }
    async function storeWithShare(password = PASSWORD) {
      const store = new QdShareStore(memoryKv(), opts);
      await store.unlock(password);
      await store.putShare({ ...ctx(2), storedAt: new Date().toISOString() }, encoded[1]!);
      return store;
    }

    it('round-trips with the wallet password and needs no other password', async () => {
      const store = await storeWithShare();
      const file = await store.walletPasswordBackup(uuid(1));
      expect(file.key).toBe('wallet-password');
      expect(Object.keys(file.context).sort()).toEqual(Object.keys(ctx(2)).sort()); // no storedAt
      const { share, context } = await decryptShareBackup(await roundTrip(file), PASSWORD, opts);
      expect(share).toEqual(encoded[1]);
      expect(context).toEqual(ctx(2));
      await expectCode(decryptShareBackup(file, 'Another-Strong-Pass-99', opts), 'BACKUP_WRONG_PASSWORD');
    });

    it('needs the store unlocked and a share for that wallet', async () => {
      const store = await storeWithShare();
      await expectCode(store.walletPasswordBackup(uuid(7)), 'NOT_FOUND');
      store.lock();
      await expectCode(store.walletPasswordBackup(uuid(1)), 'STORE_LOCKED');
    });

    it('the file kind is authenticated: relabelling either kind fails', async () => {
      const auto = await (await storeWithShare()).walletPasswordBackup(uuid(1));
      await expectCode(decryptShareBackup({ ...auto, key: 'backup-password' }, PASSWORD, opts), 'BACKUP_WRONG_PASSWORD');
      const manual = await encryptShareBackup(ctx(2), encoded[1]!, PASSWORD, opts);
      await expectCode(decryptShareBackup({ ...manual, key: 'wallet-password' }, PASSWORD, opts), 'BACKUP_WRONG_PASSWORD');
      await expectCode(() => parseShareBackup(JSON.stringify({ ...auto, key: 'other' })), 'BACKUP_INVALID');
    });

    it('after a password change, an older file still opens with the old password', async () => {
      const store = await storeWithShare();
      const before = await store.walletPasswordBackup(uuid(1));
      await store.rekey('New-Wallet-Pass-2026!');
      const after = await store.walletPasswordBackup(uuid(1));
      expect((await decryptShareBackup(before, PASSWORD, opts)).share).toEqual(encoded[1]);
      expect((await decryptShareBackup(after, 'New-Wallet-Pass-2026!', opts)).share).toEqual(encoded[1]);
      await expectCode(decryptShareBackup(before, 'New-Wallet-Pass-2026!', opts), 'BACKUP_WRONG_PASSWORD');
    });
  });
});
