/// <reference lib="webworker" />
/**
 * KeyWorker (spec §7.2). The only place in the web app where the recovery phrase
 * and derived keys exist in plaintext. The UI thread talks to it via messages and
 * receives addresses, confirmation tokens and signatures — never keys.
 */
import {
  HDKeyring,
  HDSigner,
  ConfirmationRegistry,
  SignerError,
  VaultError,
  decryptVault,
  encryptVault,
  generateMnemonic,
  isEncryptedVault,
  normalizeMnemonic,
  toHex,
  validateMnemonic,
  type EncryptedVault,
  type VaultContents,
} from '@qd/wallet-core';
import { openKv } from './idb';
import type { VaultOps, VaultOp, VaultRequestMsg, VaultResponseMsg, VaultStatus } from './vault-protocol';

declare const self: DedicatedWorkerGlobalScope;

const kv = openKv('qd-vault');
const MAX_FREE_ATTEMPTS = 5;
const ADDRESS_PROOF_RE = /^QDWallet-Address\|v1\|[0-9a-f-]{36}\|(0x[0-9a-f]{40})\|[0-9a-f-]{36}$/;

let keyring: HDKeyring | null = null;
let signer: HDSigner | null = null;
let backedUp = false;
/** Kept only between creation and completed backup verification. */
let pendingBackupPhrase: string | null = null;
let autoLockMs = 15 * 60_000;
let autoLockTimer: ReturnType<typeof setTimeout> | undefined;

class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function loadVault(): Promise<EncryptedVault | undefined> {
  const v = await kv.get<unknown>('vault');
  return isEncryptedVault(v) ? v : undefined;
}

async function lockedUntil(): Promise<number> {
  const failures = (await kv.get<number>('unlockFailures')) ?? 0;
  const last = (await kv.get<number>('lastFailureAt')) ?? 0;
  if (failures < MAX_FREE_ATTEMPTS) return 0;
  const delay = Math.min(5 * 60_000, 1000 * 2 ** (failures - MAX_FREE_ATTEMPTS));
  return last + delay;
}

async function adopt(contents: VaultContents): Promise<string> {
  lock();
  keyring = await HDKeyring.fromMnemonic(contents.mnemonic);
  signer = new HDSigner(keyring, new ConfirmationRegistry());
  backedUp = contents.backedUp || (await kv.get<boolean>('backedUp')) === true;
  pendingBackupPhrase = backedUp ? null : contents.mnemonic;
  touch();
  return keyring.evmAddress(0);
}

function lock(): void {
  keyring?.lock();
  signer?.confirmations.revokeAll();
  keyring = null;
  signer = null;
  pendingBackupPhrase = null;
  clearTimeout(autoLockTimer);
}

function touch(): void {
  clearTimeout(autoLockTimer);
  if (keyring) {
    autoLockTimer = setTimeout(() => {
      lock();
      post({ event: 'locked' });
    }, autoLockMs);
  }
}

function requireUnlocked(): { keyring: HDKeyring; signer: HDSigner } {
  if (!keyring || !signer) throw new OpError('LOCKED', 'Wallet is locked');
  return { keyring, signer };
}

/** Serializes password checks so parallel attempts cannot bypass the failure counter. */
let passwordQueue: Promise<unknown> = Promise.resolve();
function verifyAgainstVault(password: string): Promise<VaultContents> {
  const run = passwordQueue.then(() => verifyAgainstVaultUnqueued(password));
  passwordQueue = run.catch(() => undefined);
  return run;
}

async function verifyAgainstVaultUnqueued(password: string): Promise<VaultContents> {
  const vault = await loadVault();
  if (!vault) throw new OpError('NO_VAULT', 'No wallet on this device');
  const until = await lockedUntil();
  if (Date.now() < until) throw new OpError('TOO_MANY_ATTEMPTS', `Try again in ${Math.ceil((until - Date.now()) / 1000)}s`);
  try {
    const contents = await decryptVault(vault, password);
    await kv.set('unlockFailures', 0);
    return contents;
  } catch (e) {
    if (e instanceof VaultError && e.code === 'WRONG_PASSWORD') {
      await kv.set('unlockFailures', ((await kv.get<number>('unlockFailures')) ?? 0) + 1);
      await kv.set('lastFailureAt', Date.now());
      throw new OpError('WRONG_PASSWORD', 'Incorrect password');
    }
    throw e;
  }
}

const handlers: { [K in VaultOp]: (args: VaultOps[K]['req']) => Promise<VaultOps[K]['res']> } = {
  async status(): Promise<VaultStatus> {
    const vault = await loadVault();
    return { hasVault: !!vault, unlocked: !!keyring, backedUp, lockedUntil: await lockedUntil() };
  },

  async create({ password, words }) {
    if (await loadVault()) throw new OpError('VAULT_EXISTS', 'A wallet already exists on this device');
    const contents: VaultContents = {
      mnemonic: generateMnemonic(words === 24 ? 256 : 128),
      createdAt: new Date().toISOString(),
      backedUp: false,
    };
    await kv.set('vault', await encryptVault(contents, password));
    return { address: await adopt(contents) };
  },

  async import({ mnemonic, password }) {
    // Never silently replace a wallet: the user must remove it first (audit finding 10).
    if (await loadVault()) throw new OpError('VAULT_EXISTS', 'A wallet already exists on this device');
    const v = validateMnemonic(mnemonic);
    if (!v.ok) throw new OpError('INVALID_PHRASE', 'Invalid recovery phrase');
    // An imported phrase already exists elsewhere, so it counts as backed up.
    const contents: VaultContents = { mnemonic: normalizeMnemonic(mnemonic), createdAt: new Date().toISOString(), backedUp: true };
    await kv.set('vault', await encryptVault(contents, password));
    await kv.set('unlockFailures', 0);
    return { address: await adopt(contents) };
  },

  async unlock({ password }) {
    await adopt(await verifyAgainstVault(password));
    return { ok: true as const };
  },

  async lock() {
    lock();
  },

  async addresses({ indexes }) {
    const { keyring } = requireUnlocked();
    touch();
    return indexes.map((i) => keyring.evmAddress(i));
  },

  async getBackupPhrase() {
    requireUnlocked();
    if (!pendingBackupPhrase) throw new OpError('ALREADY_BACKED_UP', 'Use “Reveal recovery phrase” in Security');
    return pendingBackupPhrase;
  },

  async markBackedUp() {
    requireUnlocked();
    const vault = await loadVault();
    if (!vault || !pendingBackupPhrase) return;
    // Re-encrypting needs the password; instead store a separate non-secret flag.
    await kv.set('backedUp', true);
    backedUp = true;
    pendingBackupPhrase = null;
  },

  async revealPhrase({ password }) {
    const contents = await verifyAgainstVault(password);
    touch();
    return contents.mnemonic;
  },

  async verifyPassword({ password }) {
    try {
      await verifyAgainstVault(password);
      return true;
    } catch (e) {
      if (e instanceof OpError && e.code === 'WRONG_PASSWORD') return false;
      throw e;
    }
  },

  async changePassword({ oldPassword, newPassword }) {
    const contents = await verifyAgainstVault(oldPassword);
    await kv.set('vault', await encryptVault(contents, newPassword));
  },

  async issueConfirmation({ payload }) {
    const { signer } = requireUnlocked();
    touch();
    return signer.confirmations.issue(payload);
  },

  async sign(request) {
    const { signer } = requireUnlocked();
    touch();
    return signer.sign(request);
  },

  /**
   * Signs ONLY the fixed-format backend address-ownership message, for this
   * account's own address. Arbitrary messages go through `sign` + confirmation.
   */
  async signAddressProof({ index, message }) {
    const { keyring, signer } = requireUnlocked();
    const m = ADDRESS_PROOF_RE.exec(message);
    const address = keyring.evmAddress(index);
    if (!m || m[1] !== address.toLowerCase()) throw new OpError('INVALID_PROOF_MESSAGE', 'Refusing to sign');
    const payload = { kind: 'evm-personal-message' as const, from: address, message: toHex(new TextEncoder().encode(message)) };
    const res = await signer.sign({ account: { id: `proof-${index}`, hdIndex: index }, payload, confirmation: signer.confirmations.issue(payload) });
    if (res.kind !== 'evm-personal') throw new OpError('SIGNING_FAILED', 'Unexpected signature');
    return res.signature;
  },

  async setAutoLock({ minutes }) {
    autoLockMs = Math.max(1, Math.min(60, minutes)) * 60_000;
    touch();
  },

  async wipe() {
    lock();
    backedUp = false;
    await kv.clear();
  },
};

function post(msg: VaultResponseMsg): void {
  self.postMessage(msg);
}

// Restore the non-secret backup flag on worker start.
void kv.get<boolean>('backedUp').then((b) => {
  if (b) backedUp = true;
});

self.onmessage = async (ev: MessageEvent<VaultRequestMsg>) => {
  const { id, op, args } = ev.data;
  const handler = handlers[op] as ((a: unknown) => Promise<unknown>) | undefined;
  try {
    if (!handler) throw new OpError('UNKNOWN_OP', 'Unknown operation');
    const result = await handler(args);
    post({ id, ok: true, result });
  } catch (e) {
    const code = e instanceof OpError || e instanceof SignerError || e instanceof VaultError ? e.code : 'INTERNAL';
    // Messages are fixed strings from our own code; never include inputs.
    const message = e instanceof OpError || e instanceof SignerError || e instanceof VaultError ? e.message : 'Internal error';
    post({ id, ok: false, error: { code, message } });
  }
};
