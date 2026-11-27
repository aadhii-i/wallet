/**
 * Share backup files: one participant's own share of a shared wallet,
 * encrypted for offline keeping (a downloaded file).
 *
 * Two kinds, recorded in the file (`key`) and authenticated:
 *   - 'wallet-password': made automatically when the share is received. The
 *     key is HKDF-SHA256 of the share store's own Argon2id key (wallet
 *     password + the store's salt), so no extra password is asked for. The
 *     file is as strong as the wallet password, the same as the share store.
 *   - 'backup-password': made on request, under a separate backup password.
 *
 * The file holds only this participant's share, never anyone else's, so the
 * threshold property is unchanged: whoever steals one backup and its password
 * gets one share, not T. Encryption is the vault's construction: Argon2id
 * (wallet KDF parameters) from a backup password, then AES-256-GCM. The AAD
 * binds the format version, the full share context and the KDF header, so a
 * file cannot be edited to claim another wallet, key or party, and its KDF
 * cannot be downgraded. On restore the decrypted share is checked against the
 * context (index, T, N and master-key fingerprint) before it is returned.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fromBase64Url, toBase64Url, utf8ToBytes, wipe } from '../encoding';
import { DEFAULT_KDF, MAX_KDF, MIN_KDF, assertStrongPassword, type KdfOptions, type KdfParams } from '../vault';
import { assertShareMatches } from './ceremony';
import { ShareProvisioningError, assertShareContext, type ShareContext } from './envelope';

export const SHARE_BACKUP_FORMAT = 'qd-wallet-share-backup';
/** Upper bound on a backup file, checked before parsing. Real files are well under this. */
export const MAX_SHARE_BACKUP_BYTES = 1 << 20;

export type ShareBackupKey = 'wallet-password' | 'backup-password';

/** HKDF info for the key of a wallet-password backup, from the share store's key. */
const WALLET_PASSWORD_INFO = utf8ToBytes('QDWallet-ShareBackup|v1|wallet-password');

/** The wallet-password backup key from the share store's Argon2id key. */
export function walletPasswordBackupKey(storeKey: Uint8Array): Uint8Array {
  return hkdf(sha256, storeKey, undefined, WALLET_PASSWORD_INFO, 32);
}

export interface ShareBackupFile {
  format: typeof SHARE_BACKUP_FORMAT;
  v: 1;
  /** Which password opens the file. */
  key: ShareBackupKey;
  /** ISO time the backup was made (informational, not authenticated). */
  createdAt: string;
  /** Public: which wallet, key generation and party this share belongs to. */
  context: ShareContext;
  kdf: KdfParams;
  cipher: { alg: 'aes-256-gcm'; iv: string };
  /** base64url */
  ct: string;
}

function aad(key: ShareBackupKey, c: ShareContext, kdf: KdfParams, iv: string): Uint8Array {
  return utf8ToBytes(
    [
      'QDWallet-ShareBackup', 'v1', key, c.walletId, c.keygenId, c.participantId, c.partyIndex, c.threshold, c.parties,
      c.membershipVersion, c.fingerprint, kdf.alg, kdf.m, kdf.t, kdf.p, kdf.salt, iv,
    ].join('|'),
  );
}

function derive(password: string, kdf: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(utf8ToBytes(password.normalize('NFKC')), fromBase64Url(kdf.salt), {
    m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32, maxmem: 2 ** 31,
  });
}

const invalid = () => new ShareProvisioningError('BACKUP_INVALID', 'This is not a valid QD Wallet share backup file');

/**
 * Encrypts this device's share under `password`. Throws VaultError
 * WEAK_PASSWORD for a password the wallet itself would not accept.
 */
export async function encryptShareBackup(
  context: ShareContext,
  share: Uint8Array,
  password: string,
  opts: KdfOptions = {},
): Promise<ShareBackupFile> {
  assertShareContext(context);
  assertStrongPassword(password);
  const kdf: KdfParams = { alg: 'argon2id', ...(opts.kdf ?? DEFAULT_KDF), salt: toBase64Url(randomBytes(16)) };
  const key = await derive(password, kdf);
  try {
    return seal('backup-password', context, share, key, kdf);
  } finally {
    wipe(key);
  }
}

/**
 * Encrypts this device's share under the share store's key (see the module
 * comment), with no password prompt. `storeKey` is the store's Argon2id key
 * and `storeKdf` its header; the file then opens with the wallet password.
 */
export function encryptShareBackupWithStoreKey(context: ShareContext, share: Uint8Array, storeKey: Uint8Array, storeKdf: KdfParams): ShareBackupFile {
  assertShareContext(context);
  const key = walletPasswordBackupKey(storeKey);
  try {
    return seal('wallet-password', context, share, key, storeKdf);
  } finally {
    wipe(key);
  }
}

function seal(kind: ShareBackupKey, context: ShareContext, share: Uint8Array, key: Uint8Array, kdf: KdfParams): ShareBackupFile {
  const ctx: ShareContext = {
    walletId: context.walletId, keygenId: context.keygenId, participantId: context.participantId, partyIndex: context.partyIndex,
    threshold: context.threshold, parties: context.parties, membershipVersion: context.membershipVersion, fingerprint: context.fingerprint,
  };
  const header: KdfParams = { alg: 'argon2id', m: kdf.m, t: kdf.t, p: kdf.p, salt: kdf.salt };
  const iv = toBase64Url(randomBytes(12));
  const ct = gcm(key, fromBase64Url(iv), aad(kind, ctx, header, iv)).encrypt(share);
  return {
    format: SHARE_BACKUP_FORMAT, v: 1, key: kind, createdAt: new Date().toISOString(), context: ctx, kdf: header,
    cipher: { alg: 'aes-256-gcm', iv }, ct: toBase64Url(ct),
  };
}

/** Parses and structurally validates a backup file's text. Never decrypts. */
export function parseShareBackup(text: string): ShareBackupFile {
  if (text.length > MAX_SHARE_BACKUP_BYTES) throw invalid();
  let f: unknown;
  try {
    f = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const o = f as Partial<ShareBackupFile> | null;
  const isStr = (x: unknown): x is string => typeof x === 'string';
  const isInt = (x: unknown): x is number => Number.isInteger(x);
  if (
    !o || typeof o !== 'object' || o.format !== SHARE_BACKUP_FORMAT || o.v !== 1 ||
    (o.key !== 'wallet-password' && o.key !== 'backup-password') ||
    !o.context || typeof o.context !== 'object' ||
    !o.kdf || o.kdf.alg !== 'argon2id' || !isInt(o.kdf.m) || !isInt(o.kdf.t) || !isInt(o.kdf.p) || !isStr(o.kdf.salt) ||
    !o.cipher || o.cipher.alg !== 'aes-256-gcm' || !isStr(o.cipher.iv) || !isStr(o.ct)
  ) {
    throw invalid();
  }
  const c = o.context;
  const context: ShareContext = {
    walletId: c.walletId, keygenId: c.keygenId, participantId: c.participantId, partyIndex: c.partyIndex,
    threshold: c.threshold, parties: c.parties, membershipVersion: c.membershipVersion, fingerprint: c.fingerprint,
  };
  try {
    assertShareContext(context);
  } catch {
    throw invalid();
  }
  return {
    format: SHARE_BACKUP_FORMAT, v: 1, key: o.key, createdAt: isStr(o.createdAt) ? o.createdAt : '', context,
    kdf: { alg: 'argon2id', m: o.kdf.m, t: o.kdf.t, p: o.kdf.p, salt: o.kdf.salt },
    cipher: { alg: 'aes-256-gcm', iv: o.cipher.iv }, ct: o.ct,
  };
}

/**
 * Decrypts a backup and verifies the share against the context it claims.
 * `password` is the wallet password (for a 'wallet-password' file, the one in
 * use when the file was made) or the backup password.
 * Returns the encoded share: SECRET, the caller must store it encrypted and
 * wipe it. Errors: BACKUP_INVALID (malformed or tampered header),
 * BACKUP_WRONG_PASSWORD (wrong password or tampered ciphertext; the two are
 * indistinguishable by design), SHARE_MISMATCH.
 */
export async function decryptShareBackup(
  file: ShareBackupFile,
  password: string,
  opts: KdfOptions = {},
): Promise<{ context: ShareContext; share: Uint8Array }> {
  const { kdf, context } = file;
  const bounded = kdf.m <= MAX_KDF.m && kdf.t <= MAX_KDF.t && kdf.p <= MAX_KDF.p && kdf.p >= 1;
  const strong = kdf.m >= MIN_KDF.m && kdf.t >= MIN_KDF.t;
  if (!bounded || (!strong && !opts.allowWeakKdfForTests)) throw invalid();
  let salt: Uint8Array, iv: Uint8Array, ct: Uint8Array;
  try {
    salt = fromBase64Url(kdf.salt);
    iv = fromBase64Url(file.cipher.iv);
    ct = fromBase64Url(file.ct);
  } catch {
    throw invalid();
  }
  if (salt.length !== 16 || iv.length !== 12 || ct.length < 17) throw invalid();
  const base = await derive(password, kdf);
  const key = file.key === 'wallet-password' ? walletPasswordBackupKey(base) : base;
  if (key !== base) wipe(base);
  let share: Uint8Array;
  try {
    share = gcm(key, iv, aad(file.key, context, kdf, file.cipher.iv)).decrypt(ct);
  } catch {
    throw new ShareProvisioningError('BACKUP_WRONG_PASSWORD', 'Wrong password, or the file was modified');
  } finally {
    wipe(key);
  }
  assertShareMatches(share, context); // wipes and throws SHARE_MISMATCH on failure
  return { context, share };
}

/** The fields of the wallet's current key that a restored share must match. */
export interface ExpectedShare {
  walletId: string;
  keygenId: string;
  participantId: string;
  partyIndex: number;
  fingerprint: string;
}

/** Refuses a backup made for another wallet, an older key generation or another participant. */
export function assertBackupIsFor(file: ShareBackupFile, expected: ExpectedShare): void {
  const c = file.context;
  if (c.walletId !== expected.walletId) {
    throw new ShareProvisioningError('BACKUP_WRONG_KEY', 'This backup is for a different shared wallet');
  }
  if (c.keygenId !== expected.keygenId || c.fingerprint !== expected.fingerprint) {
    throw new ShareProvisioningError('BACKUP_WRONG_KEY', 'This backup is for an earlier key of this wallet');
  }
  if (c.participantId !== expected.participantId || c.partyIndex !== expected.partyIndex) {
    throw new ShareProvisioningError('BACKUP_WRONG_KEY', 'This backup belongs to another participant');
  }
}
