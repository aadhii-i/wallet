/// <reference lib="webworker" />
/**
 * KeyWorker (spec §7.2). The only place in the web app where the recovery phrase
 * and derived keys exist in plaintext. The UI thread talks to it via messages and
 * receives addresses, confirmation tokens and signatures — never keys.
 */
import {
  QdShareStore,
  ShareProvisioningError,
  dealShares,
  fromBase64Url,
  generateRecipientKeyPair,
  openShareEnvelope,
  toBase64Url,
  wipe,
  HDKeyring,
  HDSigner,
  ConfirmationRegistry,
  SignerError,
  VaultError,
  assertStrongPassword,
  btcDerivationPath,
  btcOwnershipProof,
  decryptVault,
  encryptVault,
  generateMnemonic,
  isEncryptedVault,
  normalizeMnemonic,
  toHex,
  validateMnemonic,
  type EncryptedVault,
  type VaultContents,
  type BitcoinSharedContext,
} from '@qd/wallet-core';
import { BitcoinSigner, extractSignedTx, psbtOutpoints, bitcoinPolicyId, bitcoinWireText, bitcoinWireBytes,
  signBitcoinEnrollment, sharedBitcoinMessage, signSharedBitcoin, finalizeSharedBitcoin, verifyBitcoinApproval,
  type BitcoinSharedPolicy, type SharedBitcoinProposal } from '@qd/bitcoin';
import { Transaction, PrivateKey } from '@hashgraph/sdk';
import {
  QdParty,
  SigningError,
  decodeKeyShare,
  decodeRound1,
  decodeRound2,
  decodeSignature,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  type KeyShare,
  publicKeyHash,
  verify as raccoonVerify,
} from '@qd/qd-crypto';
import { openKv } from './idb';
import { BITCOIN_SCAN_LIMIT, ledgerState, recordDiscovery, reserveBitcoin, type BitcoinLedger } from './bitcoin-ledger';
import type { VaultOps, VaultOp, VaultRequestMsg, VaultResponseMsg, VaultStatus } from './vault-protocol';

declare const self: DedicatedWorkerGlobalScope;

const kv = openKv('qd-vault');
const btcKv = openKv('qd-bitcoin');
function bitcoinLedgerKey(account: number, network: string, addressType: string): string {
  return `v1|${requireUnlocked().keyring.evmAddress(0)}|${network}|${addressType}|${account}`;
}
/**
 * This device's own shared-wallet key shares and per-ceremony receiving keys,
 * AES-256-GCM under an Argon2id key from the wallet password with a separate
 * salt. Never holds another participant's share.
 */
const sharesKv = openKv('qd-shares');
const shareStore = new QdShareStore(sharesKv);
const MAX_FREE_ATTEMPTS = 5;
/** Session ids this device has ever started round 1 for (public values; reuse would cancel the PRF masks). */
const USED_SIDS_KEY = 'qdUsedSids';
async function burnRaccoonSid(sid: string): Promise<void> {
  await sharesKv.update<string[]>(USED_SIDS_KEY, (previous) => {
    const used = previous ?? [];
    if (used.includes(sid)) throw new OpError('PROTOCOL_ABORT', 'Signing session identifier has already been used');
    if (used.length >= 100000) throw new OpError('PROTOCOL_ABORT', 'Signing session storage limit reached');
    return [...used, sid];
  });
}
const bitcoinParties = new Map<string, { party: QdParty; key: KeyShare; message: string; stage: 1 | 2 }>();
function clearBitcoinKey(key: KeyShare): void {
  key.share.forEach((p) => p.fill(0));
  key.seedsOut.forEach((s) => s.fill(0));
  key.seedsIn.forEach((s) => s.fill(0));
  key.chaincode.fill(0);
}
function bitcoinPolicyKey(id: string): string {
  return `bitcoin-policy|${requireUnlocked().keyring.evmAddress(0)}|${id}`;
}
function bitcoinSharedLedger(id: string): string {
  return `bitcoin-shared-ledger|${requireUnlocked().keyring.evmAddress(0)}|${id}`;
}
async function bitcoinMaterial(policy: BitcoinSharedPolicy, pinned = true) {
  requireShareStore();
  const { keyring } = requireUnlocked(),
    id = bitcoinPolicyId(policy);
  if (pinned && !(await btcKv.get(bitcoinPolicyKey(id))))
    throw new Error('Compare and confirm the Bitcoin policy safety number first');
  const slot = pinned ? `bitcoin:${id}` : policy.context.walletId;
  const info = await shareStore.shareInfo(slot);
  if (
    !info ||
    info.keygenId !== policy.context.keygenId ||
    info.membershipVersion !== policy.context.membershipVersion ||
    info.threshold !== policy.raccoonThreshold ||
    info.parties !== policy.members.length
  )
    throw new Error('This Bitcoin policy does not match the local Raccoon share');
  const member = policy.members.find((m) => m.partyIndex === info.partyIndex);
  if (!member || member.participantId !== info.participantId || member.xpub !== keyring.btcSharedRoot(policy.context))
    throw new Error('This device is not an enrolled native signer');
  const bytes = await shareStore.shareBytes(slot);
  let key: KeyShare;
  try {
    key = decodeKeyShare(bytes);
  } finally {
    wipe(bytes);
  }
  const party = new QdParty(key);
  if (bitcoinWireText(encodePublicKey(party.publicKey(policy.derivationIndex))) !== policy.raccoonPublicKey) {
    clearBitcoinKey(key);
    throw new Error('Bitcoin Raccoon public key mismatch');
  }
  return { id, info, party, key, member };
}
async function requireBitcoinApproval(policy: BitcoinSharedPolicy, proposal: SharedBitcoinProposal): Promise<string> {
  const message = Array.from(sharedBitcoinMessage(policy, proposal), (b) => b.toString(16).padStart(2, '0')).join('');
  const saved = await btcKv.get<{ message: string }>(
    `bitcoin-approval|${bitcoinPolicyKey(proposal.policyId)}|${proposal.id}`,
  );
  if (saved?.message !== message) throw new Error('Review and approve this Bitcoin proposal on this device');
  return message;
}
/**
 * In-flight signing parties, in worker memory only (round state r_j must
 * never be persisted or reused). A reload loses them: the session then fails
 * with signer_state_lost and is retried with a new sid.
 */
const signingParties = new Map<string, { party: QdParty; sid: Uint8Array; act: number[]; walletId: string }>();
const ADDRESS_PROOF_RE = /^QDWallet-Address\|v1\|[0-9a-f-]{36}\|(0x[0-9a-f]{40})\|[0-9a-f-]{36}$/;
const BTC_PROOF_RE =
  /^QDWallet-BTC\|v1\|[0-9a-f-]{36}\|(mainnet|testnet4)\|([a-z0-9]+)\|[0-9a-f-]{36}$/;

let keyring: HDKeyring | null = null;
/** One registry per unlock, shared by the EVM and Bitcoin signers. */
let confirmations: ConfirmationRegistry | null = null;
let hdSigner: HDSigner | null = null;
let btcSigner: BitcoinSigner | null = null;
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

/** Unlock the share store too, but only if one exists (avoids a second Argon2id run otherwise). */
async function unlockSharesIfPresent(password: string): Promise<void> {
  try {
    if (await shareStore.exists()) await shareStore.unlock(password);
  } catch {
    // Never block the wallet itself; QD operations will ask to unlock the share store.
  }
}

async function adopt(contents: VaultContents): Promise<string> {
  lock();
  keyring = await HDKeyring.fromMnemonic(contents.mnemonic);
  confirmations = new ConfirmationRegistry();
  hdSigner = new HDSigner(keyring, confirmations);
  btcSigner = new BitcoinSigner(keyring, confirmations);
  backedUp = contents.backedUp || (await kv.get<boolean>('backedUp')) === true;
  pendingBackupPhrase = backedUp ? null : contents.mnemonic;
  touch();
  return keyring.evmAddress(0);
}

function lock(): void {
  keyring?.lock();
  confirmations?.revokeAll();
  shareStore.lock();
  signingParties.clear(); // in-flight parties hold decoded share material
  for(const state of bitcoinParties.values())clearBitcoinKey(state.key);
  bitcoinParties.clear();
  keyring = null;
  confirmations = null;
  hdSigner = null;
  btcSigner = null;
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

function requireShareStore(): void {
  if (!shareStore.unlocked) throw new OpError('SHARE_STORE_LOCKED', 'Enter your password to unlock key-share storage');
}

function requireUnlocked(): {
  keyring: HDKeyring;
  confirmations: ConfirmationRegistry;
  hdSigner: HDSigner;
  btcSigner: BitcoinSigner;
} {
  if (!keyring || !confirmations || !hdSigner || !btcSigner) {
    throw new OpError('LOCKED', 'Wallet is locked');
  }
  return { keyring, confirmations, hdSigner, btcSigner };
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
  async btcSharedEnroll({ context, participantId, derivationIndex }) {
    const { keyring } = requireUnlocked();
    requireShareStore();
    touch();
    const info = await shareStore.shareInfo(context.walletId);
    if (
      !info ||
      info.keygenId !== context.keygenId ||
      info.membershipVersion !== context.membershipVersion ||
      info.participantId !== participantId ||
      context.network !== 'testnet4'
    )
      throw new Error('Shared Bitcoin enrollment context mismatch');
    const bytes = await shareStore.shareBytes(context.walletId);
    let key: KeyShare;
    try {
      key = decodeKeyShare(bytes);
    } finally {
      wipe(bytes);
    }
    try {
      const entry = {
        ...context,
        participantId,
        partyIndex: info.partyIndex,
        derivationIndex,
        threshold: info.threshold,
        parties: info.parties,
        xpub: keyring.btcSharedRoot(context),
        raccoonPublicKey: bitcoinWireText(encodePublicKey(new QdParty(key).publicKey(derivationIndex))),
      };
      return keyring.withBtcSharedPrivateKey(context, 0, 0, (privateKey) => signBitcoinEnrollment(entry, privateKey));
    } finally {
      clearBitcoinKey(key);
    }
  },
  async btcSharedPin({ policy, confirmation }) {
    const material = await bitcoinMaterial(policy, false);
    try {
      requireUnlocked().confirmations.consume(confirmation, {
        kind: 'bitcoin-shared',
        policyId: material.id,
        message: material.id,
      });
      await shareStore.archiveBitcoinShare(material.id, policy.context.walletId);
      await btcKv.set(bitcoinPolicyKey(material.id), policy);
      return { policyId: material.id };
    } finally {
      clearBitcoinKey(material.key);
    }
  },
  async btcSharedPlan({ policy, highestUsed }) {
    const material = await bitcoinMaterial(policy);
    try {
      const key = bitcoinSharedLedger(material.id);
      const state =
        highestUsed === undefined
          ? ledgerState(await btcKv.get<BitcoinLedger>(key))
          : await btcKv.update<BitcoinLedger>(key, (value) => recordDiscovery(value, highestUsed));
      return { next: state.next, unavailable: Object.keys(state.reservations) };
    } finally {
      clearBitcoinKey(material.key);
    }
  },
  async btcSharedApprove({ policy, proposal, confirmation }) {
    const material = await bitcoinMaterial(policy);
    try {
      const message = Array.from(sharedBitcoinMessage(policy, proposal), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      requireUnlocked().confirmations.consume(confirmation, { kind: 'bitcoin-shared', policyId: material.id, message });
      await btcKv.update<{ message: string; expiresAt: number }>(
        `bitcoin-approval|${bitcoinPolicyKey(material.id)}|${proposal.id}`,
        (previous) => {
          if (previous && previous.message !== message)
            throw new Error('This proposal identifier was already approved differently');
          return { message, expiresAt: proposal.expiresAt };
        },
      );
      return { message };
    } finally {
      clearBitcoinKey(material.key);
    }
  },
  async btcSharedRound({ policy, proposal, round, inputs }) {
    const message = await requireBitcoinApproval(policy, proposal),
      stateKey = `${bitcoinPolicyKey(proposal.policyId)}|${proposal.id}`;
    const cached = await btcKv.get<{ from: number; payload: string }>(`bitcoin-round|${stateKey}|${round}`);
    if (cached) return cached;
    const material = await bitcoinMaterial(policy);
    const index = material.info.partyIndex;
    if (!proposal.active.includes(index)) {
      clearBitcoinKey(material.key);
      throw new Error('This device is not a selected Raccoon signer');
    }
    try {
      if (round === 1) {
        await burnRaccoonSid(proposal.sid);
        const output = material.party.round1({
          sid: fromHexBytes(proposal.sid),
          act: proposal.active,
          derivationIndex: policy.derivationIndex,
          msg: fromHexBytes(message),
        });
        bitcoinParties.set(stateKey, { party: material.party, key: material.key, message, stage: 1 });
        const result = { from: index, payload: bitcoinWireText(encodeRound1(output)) };
        await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
        return result;
      }
      clearBitcoinKey(material.key);
      const state = bitcoinParties.get(stateKey);
      if (!state || state.message !== message || state.stage !== round - 1)
        throw new Error('Bitcoin signing state was lost; start a fresh proposal');
      const ordered = proposal.active.map((from) => {
        const found = inputs.filter((input) => input.from === from);
        if (found.length !== 1) throw new Error('Incomplete Raccoon round');
        return bitcoinWireBytes(found[0]!.payload);
      });
      if (round === 2) {
        const output = state.party.round2(
          fromHexBytes(proposal.sid),
          ordered.map((b, i) => decodeRound1(proposal.active[i]!, b)),
        );
        state.stage = 2;
        const result = { from: index, payload: bitcoinWireText(encodeRound2(output, proposal.active)) };
        await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
        return result;
      }
      const output = state.party.round3(
        fromHexBytes(proposal.sid),
        ordered.map((b, i) => decodeRound2(proposal.active[i]!, b, proposal.active)),
      );
      const result = { from: index, payload: bitcoinWireText(encodeRound3(output)) };
      bitcoinParties.delete(stateKey);
      clearBitcoinKey(state.key);
      await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
      return result;
    } catch (error) {
      const state = bitcoinParties.get(stateKey);
      if (state) {
        clearBitcoinKey(state.key);
        bitcoinParties.delete(stateKey);
      }
      clearBitcoinKey(material.key);
      throw error;
    }
  },
  async btcSharedNativeSign({ policy, proposal, approval }) {
    await requireBitcoinApproval(policy, proposal);
    const material = await bitcoinMaterial(policy);
    try {
      verifyBitcoinApproval(policy, proposal, approval);
      const previous = ledgerState(await btcKv.get<BitcoinLedger>(bitcoinSharedLedger(material.id))).signed[proposal.id]
        ?.raw;
      if (previous) return { partial: previous, from: material.info.partyIndex };
      let partial = '';
      const points = psbtOutpoints(proposal.psbt),
        ledgerKey = bitcoinSharedLedger(material.id);
      await btcKv.update<BitcoinLedger>(ledgerKey, (value) => {
        const state = reserveBitcoin(value, proposal.id, points, proposal.changeIndex ?? undefined);
        partial = signSharedBitcoin(policy, proposal, approval, material.info.partyIndex, (branch, index, fn) =>
          requireUnlocked().keyring.withBtcSharedPrivateKey(policy.context, branch, index, fn),
        );
        return {
          ...state,
          signed: { ...state.signed, [proposal.id]: { txid: proposal.id, raw: partial, createdAt: Date.now() } },
        };
      });
      return { partial, from: material.info.partyIndex };
    } finally {
      clearBitcoinKey(material.key);
    }
  },
  async btcSharedFinalize({ policy, proposal, approval, partials }) {
    const material = await bitcoinMaterial(policy);
    try {
      const slot = `bitcoin-final|${bitcoinPolicyKey(material.id)}|${proposal.id}`;
      const cached = await btcKv.get<{ txid: string; raw: string; vsize: number }>(slot);
      if (cached) {
        await requireBitcoinApproval(policy, proposal);
        return cached;
      }
      await requireBitcoinApproval(policy, proposal);
      const finalized = finalizeSharedBitcoin(policy, proposal, approval, partials);
      await btcKv.set(slot, finalized);
      return finalized;
    } finally {
      clearBitcoinKey(material.key);
    }
  },
  async status(): Promise<VaultStatus> {
    const vault = await loadVault();
    return { hasVault: !!vault, unlocked: !!keyring, backedUp, lockedUntil: await lockedUntil() };
  },

  async create({ password, words }) {
    if (await loadVault()) throw new OpError('VAULT_EXISTS', 'A wallet already exists on this device');
    try {
      assertStrongPassword(password);
    } catch (e) {
      if (e instanceof VaultError && e.code === 'WEAK_PASSWORD') throw new OpError('WEAK_PASSWORD', e.message);
      throw e;
    }
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
    try {
      assertStrongPassword(password);
    } catch (e) {
      if (e instanceof VaultError && e.code === 'WEAK_PASSWORD') throw new OpError('WEAK_PASSWORD', e.message);
      throw e;
    }
    const v = validateMnemonic(mnemonic);
    if (!v.ok) throw new OpError('INVALID_PHRASE', 'Invalid recovery phrase');
    // An imported phrase already exists elsewhere, so it counts as backed up.
    const contents: VaultContents = {
      mnemonic: normalizeMnemonic(mnemonic),
      createdAt: new Date().toISOString(),
      backedUp: true,
    };
    await kv.set('vault', await encryptVault(contents, password));
    await kv.set('unlockFailures', 0);
    return { address: await adopt(contents) };
  },

  async unlock({ password }) {
    await adopt(await verifyAgainstVault(password));
    await unlockSharesIfPresent(password);
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

  async btcAddress({ index, network, addressType }) {
    const { keyring } = requireUnlocked();
    touch();
    return {
      address: keyring.btcAddress(index, addressType, network),
      path: btcDerivationPath(index, addressType, network),
    };
  },

  async btcChangeAddresses({ account, start, count, network, addressType }) {
    const { keyring } = requireUnlocked();
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 20 ||
      start + count > BITCOIN_SCAN_LIMIT
    ) {
      throw new Error('Invalid discovery range');
    }
    touch();
    return Array.from({ length: count }, (_, i) => ({
      address: keyring.btcChangeAddress(account, start + i, addressType, network),
      changeIndex: start + i,
    }));
  },

  async btcChangeDescriptor({ account, network, addressType }) {
    const { keyring } = requireUnlocked();
    touch();
    return keyring.btcChangeDescriptor(account, addressType, network);
  },

  async btcChangePlan({ account, network, addressType, highestUsed }) {
    const { keyring } = requireUnlocked();
    const key = bitcoinLedgerKey(account, network, addressType);
    const state =
      highestUsed === undefined
        ? ledgerState(await btcKv.get<BitcoinLedger>(key))
        : await btcKv.update<BitcoinLedger>(key, (value) => recordDiscovery(value, highestUsed));
    touch();
    return {
      address: keyring.btcChangeAddress(account, state.next, addressType, network),
      index: state.next,
      unavailable: Object.keys(state.reservations),
      pending: Object.values(state.signed),
    };
  },

  /**
   * The account-level public descriptor for Bitcoin address derivation.
   * Public material only, but it reveals every address of this wallet on
   * that network, so it is only sent to our own backend.
   */
  async btcDescriptor({ network, addressType }) {
    const { keyring } = requireUnlocked();
    touch();
    const { descriptor, xpub, fingerprint } = keyring.btcDescriptor(addressType, network);
    return { descriptor, xpub, fingerprint };
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
    try {
      assertStrongPassword(newPassword);
    } catch (e) {
      if (e instanceof VaultError && e.code === 'WEAK_PASSWORD') throw new OpError('WEAK_PASSWORD', e.message);
      throw e;
    }
    await kv.set('vault', await encryptVault(contents, newPassword));
    if (await shareStore.exists()) {
      await shareStore.unlock(oldPassword);
      await shareStore.rekey(newPassword);
    }
  },

  async issueConfirmation({ payload }) {
    const { confirmations } = requireUnlocked();
    touch();
    return confirmations.issue(payload);
  },

  async sign(request) {
    const { keyring, confirmations, hdSigner, btcSigner } = requireUnlocked();
    touch();

    if (request.payload.kind === 'hedera-transfer') {
      const { payload, confirmation, account } = request;
      // Security guards
      const ACCOUNT_RE = /^\d+\.\d+\.\d+$/;
      if (!ACCOUNT_RE.test(payload.fromAccountId)) {
        throw new OpError('INVALID_PAYLOAD', 'Invalid fromAccountId');
      }
      if (!ACCOUNT_RE.test(payload.toAccountId)) {
        throw new OpError('INVALID_PAYLOAD', 'Invalid toAccountId');
      }
      if (payload.fromAccountId === payload.toAccountId) {
        throw new OpError('INVALID_PAYLOAD', 'fromAccountId and toAccountId must differ');
      }
      if (!/^\d+$/.test(payload.amountTinybars) || BigInt(payload.amountTinybars) <= 0n) {
        throw new OpError('INVALID_PAYLOAD', 'amountTinybars must be a positive integer string');
      }
      // Consume the confirmation token — binds signed bytes to what the user reviewed.
      confirmations.consume(confirmation, payload);
      // Reconstruct the unsigned transaction from base64 bytes.
      const txBytes = Uint8Array.from(Buffer.from(payload.transactionBytes, 'base64'));
      const tx = Transaction.fromBytes(txBytes);
      // Sign inside a scoped callback so the private key is wiped after use.
      keyring.withHederaPrivateKey(account.hdIndex, (pk) => {
        const hederaKey = PrivateKey.fromBytesECDSA(pk);
        hederaKey.signTransaction(tx);
      });
      const signedBytes = Buffer.from(tx.toBytes()).toString('base64');
      return { kind: 'hedera-transfer' as const, signerKind: 'hd' as const, signedBytes };
    }

    if (request.payload.kind === 'hedera-account-create') {
      const { payload, confirmation, account } = request;
      // Consume the confirmation token — binds signed bytes to what was reviewed.
      confirmations.consume(confirmation, payload);
      // Reconstruct the unsigned transaction from base64 bytes.
      const txBytes = Uint8Array.from(Buffer.from(payload.transactionBytes, 'base64'));
      const tx = Transaction.fromBytes(txBytes);
      // Sign with the payer key (required) inside a scoped callback, then wipe all references.
      let payerKey: PrivateKey | null = null;
      try {
        payerKey = PrivateKey.fromStringECDSA(payload.payerPrivateKeyHex);
        payerKey.signTransaction(tx);
      } finally {
        // Zero out references — the payer key is never cached, returned, or logged.
        payload.payerPrivateKeyHex = '';
        payerKey = null;
      }
      // Optionally sign with the wallet's derived key (proof of intent; not
      // required by the network). Derived key is wiped by the keyring callback.
      keyring.withHederaPrivateKey(account.hdIndex, (walletPk) => {
        const walletKey = PrivateKey.fromBytesECDSA(walletPk);
        walletKey.signTransaction(tx);
      });
      const signedBytes = Buffer.from(tx.toBytes()).toString('base64');
      return { kind: 'hedera-account-create' as const, signerKind: 'hd' as const, signedBytes };
    }

    if (request.payload.kind !== 'btc-psbt') return hdSigner.sign(request);
    btcSigner.validate(request);
    const payload = request.payload;
    const review = payload.review!;
    const key = bitcoinLedgerKey(request.account.hdIndex, payload.network, payload.addressType);
    const points = psbtOutpoints(payload.psbt);
    let signed: ReturnType<BitcoinSigner['sign']> | undefined;
    // Synchronous signing and metadata commit occur in the same serialized IDB
    // transaction. No signature leaves the worker unless persistence succeeds.
    await btcKv.update<BitcoinLedger>(key, (value) => {
      const state = reserveBitcoin(value, request.confirmation.id, points, review.changeIndex);
      signed = btcSigner!.sign(request);
      if (signed.kind !== 'btc-psbt') throw new Error('Unexpected Bitcoin signature');
      const raw = extractSignedTx(signed.psbt);
      return {
        ...state,
        signed: {
          ...state.signed,
          [raw.txid]: { txid: raw.txid, raw: raw.rawHex, createdAt: Date.now() },
        },
      };
    });
    if (!signed) throw new Error('Bitcoin signature was not persisted');
    return signed;
  },

  /**
   * Signs ONLY the fixed-format backend address-ownership message, for this
   * account's own address. Arbitrary messages go through `sign` + confirmation.
   */
  async signAddressProof({ index, message }) {
    const { keyring, hdSigner } = requireUnlocked();
    const m = ADDRESS_PROOF_RE.exec(message);
    const address = keyring.evmAddress(index);
    if (!m || m[1] !== address.toLowerCase()) throw new OpError('INVALID_PROOF_MESSAGE', 'Refusing to sign');
    const payload = {
      kind: 'evm-personal-message' as const,
      from: address,
      message: toHex(new TextEncoder().encode(message)),
    };
    const res = await hdSigner.sign({
      account: { id: `proof-${index}`, hdIndex: index },
      payload,
      confirmation: hdSigner.confirmations.issue(payload),
    });
    if (res.kind !== 'evm-personal') throw new OpError('SIGNING_FAILED', 'Unexpected signature');
    return res.signature;
  },

  /**
   * Fixed-format Bitcoin ownership proof. The message names the account, the
   * network and the address, and the worker independently re-derives the
   * address, so it can never sign for an address it does not control.
   */
  async signBtcAddressProof({ index, network, addressType, message }) {
    const { keyring } = requireUnlocked();
    touch();
    const address = keyring.btcAddress(index, addressType, network);
    const m = BTC_PROOF_RE.exec(message);
    if (!m || m[1] !== network || m[2] !== address) {
      throw new OpError('INVALID_PROOF_MESSAGE', 'Refusing to sign');
    }
    const proof = keyring.withBtcPrivateKey(index, addressType, network, (privateKey) =>
      btcOwnershipProof(privateKey, message),
    );
    return { proof };
  },

  async hederaPublicKey({ index }) {
    const { keyring } = requireUnlocked();
    touch();
    return { publicKey: keyring.hederaPublicKey(index) };
  },

  async setAutoLock({ minutes }) {
    autoLockMs = Math.max(1, Math.min(60, minutes)) * 60_000;
    touch();
  },

  async wipe() {
    lock();
    backedUp = false;
    await kv.clear();
    await sharesKv.clear();
    await btcKv.clear();
  },

  // ---- shared-wallet QD key generation (trusted dealer; see wallet-core qd-shares) ----

  async qdShareUnlock({ password }) {
    requireUnlocked();
    await verifyAgainstVault(password); // same password as the vault, checked against it first
    await shareStore.unlock(password);
    touch();
  },

  async qdShareStatus({ walletId }) {
    const info = await shareStore.shareInfo(walletId);
    return {
      storeExists: await shareStore.exists(),
      storeUnlocked: shareStore.unlocked,
      share: info
        ? {
            keygenId: info.keygenId,
            participantId: info.participantId,
            partyIndex: info.partyIndex,
            threshold: info.threshold,
            parties: info.parties,
            membershipVersion: info.membershipVersion,
            fingerprint: info.fingerprint,
            storedAt: info.storedAt,
          }
        : null,
    };
  },

  /** Fresh X-Wing key pair for one ceremony; the private key is stored encrypted and never leaves the worker. */
  async qdPrepareKeygen({ walletId, keygenId, participantId }) {
    requireUnlocked();
    requireShareStore();
    touch();
    const existing = await shareStore.recipientKeyInfo(keygenId);
    if (existing) return { publicKey: existing.publicKey };
    const kp = await generateRecipientKeyPair();
    try {
      const publicKey = toBase64Url(kp.publicKey);
      await shareStore.putRecipientKey({ walletId, keygenId, participantId, publicKey }, kp.privateKey);
      return { publicKey };
    } finally {
      wipe(kp.privateKey);
    }
  },

  /**
   * Trusted dealer: generates the master key and every share inside this one
   * call, self-checks them, seals each to its recipient and returns only
   * ciphertexts and the public fingerprint. Nothing secret is persisted.
   */
  async qdDeal(req) {
    requireUnlocked();
    touch();
    const out = await dealShares({
      walletId: req.walletId,
      keygenId: req.keygenId,
      threshold: req.threshold,
      parties: req.parties,
      membershipVersion: req.membershipVersion,
      recipients: req.recipients.map((r) => ({
        participantId: r.participantId,
        partyIndex: r.partyIndex,
        publicKey: fromBase64Url(r.publicKey),
      })),
    });
    return {
      fingerprint: out.fingerprint,
      envelopes: out.envelopes.map((e) => ({
        participantId: e.participantId,
        partyIndex: e.partyIndex,
        enc: toBase64Url(e.enc),
        ct: toBase64Url(e.ct),
      })),
    };
  },

  /** Opens this device's envelope, verifies the share against the promised context, stores it encrypted. */
  async qdAcceptShare(req) {
    requireUnlocked();
    requireShareStore();
    touch();
    const { enc, ct, ...context } = req;
    const sk = await shareStore.recipientPrivateKey(req.keygenId);
    let share: Uint8Array | undefined;
    try {
      share = await openShareEnvelope(sk, context, { enc: fromBase64Url(enc), ct: fromBase64Url(ct) });
      await shareStore.putShare({ ...context, storedAt: new Date().toISOString() }, share);
    } finally {
      wipe(sk, share);
    }
    await shareStore.deleteRecipientKey(req.keygenId);
    return { fingerprint: req.fingerprint, partyIndex: req.partyIndex };
  },

  // ---- shared-wallet networked signing (QD-Wallet Alg. 4) ----

  /** pk_j for an account: derived from this device's share (RandPK); public. */
  async qdAccountKey({ walletId, derivationIndex }) {
    requireUnlocked();
    requireShareStore();
    touch();
    const info = await shareStore.shareInfo(walletId);
    if (!info) throw new OpError('NO_SHARE', 'This device holds no key share for this wallet');
    const bytes = await shareStore.shareBytes(walletId);
    try {
      const pk = new QdParty(decodeKeyShare(bytes)).publicKey(derivationIndex);
      return {
        publicKey: toBase64Url(encodePublicKey(pk)),
        publicKeyHash: toHex(publicKeyHash(pk)),
        keygenId: info.keygenId,
        partyIndex: info.partyIndex,
      };
    } finally {
      wipe(bytes);
    }
  },

  async qdSignRound(req) {
    requireUnlocked();
    requireShareStore();
    touch();
    const bad = (m: string) => new OpError('SIGNING_REFUSED', m);
    if (
      !/^[0-9a-f]{64}$/.test(req.sid) ||
      !/^0x[0-9a-f]{64}$/i.test(req.message) ||
      !/^0x[0-9a-f]{64}$/i.test(req.publicKeyHash)
    ) {
      throw bad('Malformed signing request');
    }
    const sid = fromHexBytes(req.sid);
    const msg = fromHexBytes(req.message.slice(2));
    try {
      if (req.round === 1) {
        if (signingParties.has(req.sessionId)) throw bad('Round 1 already produced for this session');
        const info = await shareStore.shareInfo(req.walletId);
        if (!info || info.keygenId !== req.keygenId)
          throw new OpError('NO_SHARE', 'This device holds no share of this session’s key');
        if (!req.act.includes(info.partyIndex)) throw bad('This device is not a selected signer');
        const bytes = await shareStore.shareBytes(req.walletId);
        let party: QdParty;
        try {
          party = new QdParty(decodeKeyShare(bytes));
        } finally {
          wipe(bytes);
        }
        // The session must be for the account key this share actually controls.
        if (toHex(publicKeyHash(party.publicKey(req.derivationIndex))) !== req.publicKeyHash.toLowerCase()) {
          throw bad('Session public key does not match this device’s account key');
        }
        await burnRaccoonSid(req.sid);
        const r1 = party.round1({ sid, act: req.act, derivationIndex: req.derivationIndex, msg });
        signingParties.set(req.sessionId, { party, sid, act: [...req.act], walletId: req.walletId });
        return { payload: toBase64Url(encodeRound1(r1)) };
      }
      const st = signingParties.get(req.sessionId);
      if (!st || st.walletId !== req.walletId || toHex(st.sid).slice(2) !== req.sid) {
        throw new OpError('SIGNER_STATE_LOST', 'This device no longer holds the round state for this session');
      }
      if (req.inputs.length !== st.act.length) throw bad('Wrong number of round inputs');
      const inputs = req.inputs.map(fromBase64Url);
      if (req.round === 2) {
        const r2 = st.party.round2(
          st.sid,
          inputs.map((b, k) => decodeRound1(st.act[k]!, b)),
        );
        return { payload: toBase64Url(encodeRound2(r2, st.act)) };
      }
      signingParties.delete(req.sessionId); // round 3 consumes r_j
      const r3 = st.party.round3(
        st.sid,
        inputs.map((b, k) => decodeRound2(st.act[k]!, b, st.act)),
      );
      return { payload: toBase64Url(encodeRound3(r3)) };
    } catch (e) {
      if (e instanceof SigningError) {
        signingParties.delete(req.sessionId);
        throw new OpError('PROTOCOL_ABORT', e.message);
      }
      if (e instanceof OpError) throw e;
      signingParties.delete(req.sessionId);
      throw new OpError('PROTOCOL_ABORT', 'Malformed round message');
    }
  },

  async qdForgetSession({ sessionId }) {
    signingParties.delete(sessionId);
  },

  /** Independent check on this device: the coordinator's signature verifies under this device's own pk_j. */
  async qdVerifySignature({ walletId, derivationIndex, message, signature }) {
    requireUnlocked();
    requireShareStore();
    const bytes = await shareStore.shareBytes(walletId);
    try {
      const pk = new QdParty(decodeKeyShare(bytes)).publicKey(derivationIndex);
      return raccoonVerify(pk, fromHexBytes(message.replace(/^0x/, '')), decodeSignature(fromBase64Url(signature)));
    } catch {
      return false;
    } finally {
      wipe(bytes);
    }
  },
};

function fromHexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

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
    const known = e instanceof OpError || e instanceof SignerError || e instanceof VaultError || e instanceof ShareProvisioningError;
    const code = known ? e.code : 'INTERNAL';
    // Messages are fixed strings from our own code; never include inputs or key material.
    const message = known ? e.message : 'Internal error';
    post({ id, ok: false, error: { code, message } });
  }
};
