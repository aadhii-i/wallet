/**
 * Encrypted local store for this device's own QD material: its key share per
 * shared wallet, and the X-Wing private key used to receive a share while a
 * key generation is open. Never holds another participant's share.
 *
 * At rest: AES-256-GCM under a key derived with Argon2id from the wallet
 * password and a salt separate from the vault's (Phase 3.2 decision: the vault
 * format is unchanged). The whole store is one value, so password rotation
 * re-encrypts it in a single atomic write.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fromBase64Url, toBase64Url, utf8ToBytes, wipe } from '../encoding';
import { DEFAULT_KDF, MAX_KDF, MIN_KDF, type KdfOptions } from '../vault';
import { ShareProvisioningError, type ShareContext } from './envelope';

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface Sealed {
  iv: string;
  ct: string;
}

/** Non-secret metadata, authenticated as AAD. */
export type ShareInfo = ShareContext & { storedAt: string };
export interface RecipientKeyInfo {
  walletId: string;
  keygenId: string;
  participantId: string;
  publicKey: string; // base64url
}

interface StoreValue {
  v: 1;
  kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string };
  check: Sealed;
  shares: Record<string, { info: ShareInfo; sealed: Sealed }>;
  recipientKeys: Record<string, { info: RecipientKeyInfo; sealed: Sealed }>;
}

const KEY = 'qdShareStore';
const CHECK = utf8ToBytes('qd-share-store-check');

function aad(kind: string, id: string, info: unknown): Uint8Array {
  return utf8ToBytes(`qd-share-store|v1|${kind}|${id}|${JSON.stringify(info)}`);
}

function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Sealed {
  const iv = randomBytes(12);
  return { iv: toBase64Url(iv), ct: toBase64Url(gcm(key, iv, ad).encrypt(plaintext)) };
}

function open(key: Uint8Array, s: Sealed, ad: Uint8Array): Uint8Array {
  try {
    return gcm(key, fromBase64Url(s.iv), ad).decrypt(fromBase64Url(s.ct));
  } catch {
    throw new ShareProvisioningError('STORE_CORRUPT', 'Share store could not be decrypted');
  }
}

export class QdShareStore {
  private key: Uint8Array | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: Kv,
    private readonly opts: KdfOptions = {},
  ) {}

  async exists(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Serializes read-modify-write cycles on the single store value. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async derive(password: string, kdf: StoreValue['kdf']): Promise<Uint8Array> {
    const bounded = kdf.m <= MAX_KDF.m && kdf.t <= MAX_KDF.t && kdf.p <= MAX_KDF.p;
    const strong = kdf.m >= MIN_KDF.m && kdf.t >= MIN_KDF.t && kdf.p >= 1;
    if (!bounded || (!strong && !this.opts.allowWeakKdfForTests)) {
      throw new ShareProvisioningError('STORE_CORRUPT', 'Share store parameters are invalid');
    }
    return argon2idAsync(utf8ToBytes(password.normalize('NFKC')), fromBase64Url(kdf.salt), {
      m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32, maxmem: 2 ** 31,
    });
  }

  private async load(): Promise<StoreValue | undefined> {
    return this.kv.get<StoreValue>(KEY);
  }

  private async fresh(password: string): Promise<{ value: StoreValue; key: Uint8Array }> {
    const params = this.opts.kdf ?? DEFAULT_KDF;
    const kdf = { alg: 'argon2id' as const, ...params, salt: toBase64Url(randomBytes(16)) };
    const key = await this.derive(password, kdf);
    return { key, value: { v: 1, kdf, check: seal(key, CHECK, aad('check', '', null)), shares: {}, recipientKeys: {} } };
  }

  /**
   * Derives the store key. The caller must already have verified the password
   * against the vault. Creates the store (with its own salt) on first use.
   */
  unlock(password: string): Promise<void> {
    return this.exclusive(async () => {
      const existing = await this.load();
      if (!existing) {
        const { value, key } = await this.fresh(password);
        await this.kv.set(KEY, value);
        this.setKey(key);
        return;
      }
      const key = await this.derive(password, existing.kdf);
      try {
        wipe(open(key, existing.check, aad('check', '', null)));
      } catch {
        wipe(key);
        throw new ShareProvisioningError('STORE_LOCKED', 'Share store password mismatch');
      }
      this.setKey(key);
    });
  }

  private setKey(key: Uint8Array): void {
    if (this.key) wipe(this.key);
    this.key = key;
  }

  lock(): void {
    if (this.key) wipe(this.key);
    this.key = null;
  }

  private requireKey(): Uint8Array {
    if (!this.key) throw new ShareProvisioningError('STORE_LOCKED', 'Share store is locked');
    return this.key;
  }

  private async mutate(fn: (v: StoreValue, key: Uint8Array) => void): Promise<void> {
    return this.exclusive(async () => {
      const key = this.requireKey();
      const v = await this.load();
      if (!v) throw new ShareProvisioningError('STORE_LOCKED', 'Share store is locked');
      fn(v, key);
      await this.kv.set(KEY, v);
    });
  }

  async putRecipientKey(info: RecipientKeyInfo, privateKey: Uint8Array): Promise<void> {
    await this.mutate((v, key) => {
      v.recipientKeys[info.keygenId] = { info, sealed: seal(key, privateKey, aad('rk', info.keygenId, info)) };
    });
  }

  async recipientKeyInfo(keygenId: string): Promise<RecipientKeyInfo | undefined> {
    return (await this.load())?.recipientKeys[keygenId]?.info;
  }

  /** SECRET result; only for opening this device's own envelope. */
  async recipientPrivateKey(keygenId: string): Promise<Uint8Array> {
    const key = this.requireKey();
    const rec = (await this.load())?.recipientKeys[keygenId];
    if (!rec) throw new ShareProvisioningError('NOT_FOUND', 'No receiving key for this key generation on this device');
    return open(key, rec.sealed, aad('rk', keygenId, rec.info));
  }

  async deleteRecipientKey(keygenId: string): Promise<void> {
    await this.mutate((v) => {
      delete v.recipientKeys[keygenId];
    });
  }

  /** Stores this device's share for a wallet, replacing any share of an earlier key generation. */
  async putShare(info: ShareInfo, shareBytes: Uint8Array): Promise<void> {
    await this.mutate((v, key) => {
      v.shares[info.walletId] = { info, sealed: seal(key, shareBytes, aad('share', info.walletId, info)) };
    });
  }

  async shareInfo(walletId: string): Promise<ShareInfo | undefined> {
    return (await this.load())?.shares[walletId]?.info;
  }

  /** SECRET result; for the (future) signing session inside the key worker only. */
  async shareBytes(walletId: string): Promise<Uint8Array> {
    const key = this.requireKey();
    const rec = (await this.load())?.shares[walletId];
    if (!rec) throw new ShareProvisioningError('NOT_FOUND', 'No share for this wallet on this device');
    return open(key, rec.sealed, aad('share', walletId, rec.info));
  }

  /** Re-encrypts everything under a key from the new password, in one write. */
  rekey(newPassword: string): Promise<void> {
    return this.exclusive(async () => {
      const oldKey = this.requireKey();
      const v = await this.load();
      if (!v) return;
      const { value: next, key: newKey } = await this.fresh(newPassword);
      for (const [id, rec] of Object.entries(v.shares)) {
        const pt = open(oldKey, rec.sealed, aad('share', id, rec.info));
        next.shares[id] = { info: rec.info, sealed: seal(newKey, pt, aad('share', id, rec.info)) };
        wipe(pt);
      }
      for (const [id, rec] of Object.entries(v.recipientKeys)) {
        const pt = open(oldKey, rec.sealed, aad('rk', id, rec.info));
        next.recipientKeys[id] = { info: rec.info, sealed: seal(newKey, pt, aad('rk', id, rec.info)) };
        wipe(pt);
      }
      await this.kv.set(KEY, next);
      this.setKey(newKey);
    });
  }
}
