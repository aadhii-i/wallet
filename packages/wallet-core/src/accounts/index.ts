import { assertIndex, evmDerivationPath } from '../derivation';

/**
 * Public, non-secret metadata for one HD account. Never contains keys: the
 * address is re-derivable from the recovery phrase and `index` alone.
 */
export interface HDAccountMeta {
  index: number;
  name: string;
  address: string;
  /** Derivation path the address came from (informational; always evmDerivationPath(index)). */
  path?: string;
  createdAt?: number;
  hidden?: boolean;
  apiId?: string;
}

export function defaultAccountName(index: number): string {
  return `Account ${index + 1}`;
}

export function makeAccountMeta(index: number, address: string, name = defaultAccountName(index), now = Date.now()): HDAccountMeta {
  assertIndex(index);
  return { index, name, address, path: evmDerivationPath(index), createdAt: now };
}

/** Next index after the highest one in use (hidden accounts still occupy their index). */
export function nextAccountIndex(accounts: readonly { index: number }[]): number {
  const next = accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
  assertIndex(next);
  return next;
}

/** Indexes the vault must derive to verify `stored` (account 0 when nothing is stored). */
export function indexesToVerify(stored: readonly { index: number }[]): number[] {
  return stored.length > 0 ? stored.map((a) => a.index) : [0];
}

export type ReconcileResult<T extends HDAccountMeta> =
  | { status: 'ok'; accounts: T[] }
  /** Stored metadata was empty or belonged to another phrase; rebuilt from the vault. */
  | { status: 'rebuilt'; accounts: HDAccountMeta[] };

/**
 * Checks stored account metadata against the addresses the unlocked vault
 * derives for `indexesToVerify(stored)`. If any stored address differs, the
 * metadata is not this wallet's and is rebuilt (same indexes, fresh names), so
 * the UI can never display one account while signing as another.
 */
export function reconcileAccounts<T extends HDAccountMeta>(stored: readonly T[], derived: readonly string[], now = Date.now()): ReconcileResult<T> {
  const indexes = indexesToVerify(stored);
  if (derived.length !== indexes.length) throw new Error('Derived address count does not match the accounts to verify');
  if (stored.length > 0 && stored.every((a, i) => a.address.toLowerCase() === derived[i]!.toLowerCase())) {
    return { status: 'ok', accounts: [...stored] };
  }
  return { status: 'rebuilt', accounts: indexes.map((index, i) => makeAccountMeta(index, derived[i]!, undefined, now)) };
}
