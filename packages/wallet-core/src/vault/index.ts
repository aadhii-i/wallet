import { argon2idAsync } from '@noble/hashes/argon2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { fromBase64Url, toBase64Url, utf8ToBytes, wipe } from '../encoding';

/**
 * Encrypted vault (ADR-004). Only the ciphertext is ever persisted.
 * KDF: Argon2id; cipher: AES-256-GCM with AAD binding the header.
 */
export interface KdfParams {
  alg: 'argon2id';
  /** memory in KiB */
  m: number;
  t: number;
  p: number;
  /** base64url, 16 bytes */
  salt: string;
}

export interface EncryptedVault {
  v: 1;
  kdf: KdfParams;
  cipher: { alg: 'aes-256-gcm'; iv: string };
  /** base64url */
  ct: string;
}

export interface VaultContents {
  mnemonic: string;
  createdAt: string;
  /** true once the user completed recovery-phrase verification */
  backedUp: boolean;
}

export const DEFAULT_KDF = { m: 65536, t: 2, p: 1 } as const;
/** Lower bound accepted when decrypting, so a tampered header cannot downgrade the KDF. */
export const MIN_KDF = { m: 19456, t: 2, p: 1 } as const;
/** Upper bound so a tampered header cannot freeze the device with a huge KDF. */
export const MAX_KDF = { m: 262144, t: 10, p: 4 } as const;

export class VaultError extends Error {
  constructor(
    readonly code: 'WRONG_PASSWORD' | 'CORRUPT' | 'WEAK_PARAMS' | 'UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

function aad(kdf: KdfParams, iv: string): Uint8Array {
  return utf8ToBytes(`qd-vault|v1|${kdf.alg}|${kdf.m}|${kdf.t}|${kdf.p}|${kdf.salt}|${iv}`);
}

async function deriveKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(utf8ToBytes(password.normalize('NFKC')), fromBase64Url(kdf.salt), {
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
    maxmem: 2 ** 31,
  });
}

export interface KdfOptions {
  kdf?: { m: number; t: number; p: number };
  /** Test-only escape hatch for fast unit tests. Never set in app code. */
  allowWeakKdfForTests?: boolean;
}

export async function encryptVault(
  contents: VaultContents,
  password: string,
  opts: KdfOptions = {},
): Promise<EncryptedVault> {
  const params = opts.kdf ?? DEFAULT_KDF;
  if (!opts.allowWeakKdfForTests) assertStrongParams(params);
  const kdf: KdfParams = { alg: 'argon2id', ...params, salt: toBase64Url(randomBytes(16)) };
  const iv = toBase64Url(randomBytes(12));
  const key = await deriveKey(password, kdf);
  const plaintext = utf8ToBytes(JSON.stringify(contents));
  try {
    const ct = gcm(key, fromBase64Url(iv), aad(kdf, iv)).encrypt(plaintext);
    return { v: 1, kdf, cipher: { alg: 'aes-256-gcm', iv }, ct: toBase64Url(ct) };
  } finally {
    wipe(key, plaintext);
  }
}

export async function decryptVault(
  vault: EncryptedVault,
  password: string,
  opts: Pick<KdfOptions, 'allowWeakKdfForTests'> = {},
): Promise<VaultContents> {
  if (!isEncryptedVault(vault)) throw new VaultError('UNSUPPORTED', 'Unsupported vault format');
  if (!opts.allowWeakKdfForTests) assertStrongParams(vault.kdf);
  assertBoundedParams(vault.kdf);
  const key = await deriveKey(password, vault.kdf);
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, fromBase64Url(vault.cipher.iv), aad(vault.kdf, vault.cipher.iv)).decrypt(
      fromBase64Url(vault.ct),
    );
  } catch {
    // A wrong password and a tampered ciphertext are indistinguishable by design.
    throw new VaultError('WRONG_PASSWORD', 'Incorrect password');
  } finally {
    wipe(key);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isVaultContents(parsed)) throw new VaultError('CORRUPT', 'Vault contents are invalid');
    return parsed;
  } finally {
    wipe(plaintext);
  }
}

function assertStrongParams(p: { m: number; t: number; p: number }): void {
  if (p.m < MIN_KDF.m || p.t < MIN_KDF.t || p.p < 1) {
    throw new VaultError('WEAK_PARAMS', 'Vault key-derivation parameters are below the minimum');
  }
}

function assertBoundedParams(p: { m: number; t: number; p: number }): void {
  if (!Number.isInteger(p.m) || !Number.isInteger(p.t) || !Number.isInteger(p.p) || p.m > MAX_KDF.m || p.t > MAX_KDF.t || p.p > MAX_KDF.p) {
    throw new VaultError('UNSUPPORTED', 'Vault key-derivation parameters are out of range');
  }
}

function isVaultContents(x: unknown): x is VaultContents {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.mnemonic === 'string' && typeof o.createdAt === 'string' && typeof o.backedUp === 'boolean';
}

export function isEncryptedVault(x: unknown): x is EncryptedVault {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { v?: unknown; kdf?: Record<string, unknown>; cipher?: Record<string, unknown>; ct?: unknown };
  return (
    o.v === 1 &&
    o.kdf?.alg === 'argon2id' &&
    typeof o.kdf.m === 'number' &&
    typeof o.kdf.t === 'number' &&
    typeof o.kdf.p === 'number' &&
    typeof o.kdf.salt === 'string' &&
    o.cipher?.alg === 'aes-256-gcm' &&
    typeof o.cipher.iv === 'string' &&
    typeof o.ct === 'string'
  );
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  ok: boolean;
  hint?: string;
}

/** Minimal local strength check; the UI requires ok=true before creating a vault. */
export function checkPasswordStrength(pw: string): PasswordStrength {
  if (pw.length < 8) return { score: 0, ok: false, hint: 'Use at least 8 characters' };
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const lengthBonus = pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0;
  const score = Math.min(4, Math.max(1, classes - 1 + lengthBonus)) as 1 | 2 | 3 | 4;
  if (score < 2) return { score, ok: false, hint: 'Add numbers, symbols or more length' };
  return { score, ok: true };
}
