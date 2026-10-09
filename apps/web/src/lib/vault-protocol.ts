import type { ConfirmationToken, SignatureResult, SigningPayload, SigningRequest } from '@qd/wallet-core';

/** Typed message protocol between the UI thread and the KeyWorker. */
export interface VaultOps {
  status: { req: void; res: VaultStatus };
  create: { req: { password: string; words: 12 | 24 }; res: { address: string } };
  import: { req: { mnemonic: string; password: string }; res: { address: string } };
  unlock: { req: { password: string }; res: { ok: true } };
  lock: { req: void; res: void };
  addresses: { req: { indexes: number[] }; res: string[] };
  getBackupPhrase: { req: void; res: string };
  markBackedUp: { req: void; res: void };
  revealPhrase: { req: { password: string }; res: string };
  verifyPassword: { req: { password: string }; res: boolean };
  changePassword: { req: { oldPassword: string; newPassword: string }; res: void };
  issueConfirmation: { req: { payload: SigningPayload }; res: ConfirmationToken };
  sign: { req: SigningRequest; res: SignatureResult };
  signAddressProof: { req: { index: number; message: string }; res: string };
  setAutoLock: { req: { minutes: number }; res: void };
  wipe: { req: void; res: void };
}

export type VaultOp = keyof VaultOps;

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  backedUp: boolean;
  /** Unix ms until which unlock attempts are refused (brute-force delay). */
  lockedUntil: number;
}

export interface VaultRequestMsg<K extends VaultOp = VaultOp> {
  id: number;
  op: K;
  args: VaultOps[K]['req'];
}

export type VaultResponseMsg =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { event: 'locked' };
