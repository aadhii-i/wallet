'use client';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { TxStatus } from '@qd/shared-types';
import type { HDAccountMeta } from '@qd/wallet-core';

/**
 * Non-secret wallet metadata (names, public addresses, preferences). Persisted in
 * localStorage for convenience — it never contains keys, phrases or passwords.
 */
export type AccountMeta = HDAccountMeta;

export interface LocalTx {
  hash: string;
  networkId: string;
  from: string;
  to: string;
  assetId: string;
  amount: string;
  fee?: string;
  status: TxStatus;
  createdAt: number;
  nonce?: number;
}

interface MetaState {
  accounts: AccountMeta[];
  selectedIndex: number;
  networkId: string;
  customRpc: Record<string, string>;
  autoLockMinutes: number;
  walletApiId?: string;
  /** lowercase account address → lowercase recipients previously sent to. */
  knownRecipients: Record<string, string[]>;
  localTxs: LocalTx[];
  hideBalances: boolean;
  /** "chainId:address" → last nonce this device broadcast (not secret). */
  nonces: Record<string, number>;

  setNonces(n: Record<string, number>): void;
  setAccounts(accounts: AccountMeta[]): void;
  addAccount(a: AccountMeta): void;
  renameAccount(index: number, name: string): void;
  setAccountApiId(index: number, apiId: string): void;
  selectAccount(index: number): void;
  selectNetwork(id: string): void;
  setCustomRpc(networkId: string, url: string | null): void;
  setAutoLockMinutes(m: number): void;
  setWalletApiId(id: string): void;
  rememberRecipient(from: string, to: string): void;
  upsertLocalTx(tx: LocalTx): void;
  toggleHideBalances(): void;
  reset(): void;
}

// Never default to a local chain: Anvil is opt-in from the network sheet.
const DEFAULT_NETWORK = 'sepolia';

const initial = {
  accounts: [] as AccountMeta[],
  selectedIndex: 0,
  networkId: DEFAULT_NETWORK,
  customRpc: {} as Record<string, string>,
  autoLockMinutes: 15,
  knownRecipients: {} as Record<string, string[]>,
  localTxs: [] as LocalTx[],
  hideBalances: false,
  nonces: {} as Record<string, number>,
};

export const useMeta = create<MetaState>()(
  persist(
    (set) => ({
      ...initial,
      setNonces: (nonces) => set({ nonces }),
      setAccounts: (accounts) => set({ accounts, selectedIndex: accounts[0]?.index ?? 0 }),
      addAccount: (a) => set((s) => ({ accounts: [...s.accounts.filter((x) => x.index !== a.index), a].sort((x, y) => x.index - y.index), selectedIndex: a.index })),
      renameAccount: (index, name) => set((s) => ({ accounts: s.accounts.map((a) => (a.index === index ? { ...a, name } : a)) })),
      setAccountApiId: (index, apiId) => set((s) => ({ accounts: s.accounts.map((a) => (a.index === index ? { ...a, apiId } : a)) })),
      selectAccount: (selectedIndex) => set({ selectedIndex }),
      selectNetwork: (networkId) => set({ networkId }),
      setCustomRpc: (networkId, url) =>
        set((s) => {
          const next = { ...s.customRpc };
          if (url) next[networkId] = url;
          else delete next[networkId];
          return { customRpc: next };
        }),
      setAutoLockMinutes: (autoLockMinutes) => set({ autoLockMinutes }),
      setWalletApiId: (walletApiId) => set({ walletApiId }),
      rememberRecipient: (from, to) =>
        set((s) => {
          const k = from.toLowerCase();
          const list = new Set(s.knownRecipients[k] ?? []);
          list.add(to.toLowerCase());
          return { knownRecipients: { ...s.knownRecipients, [k]: [...list].slice(-200) } };
        }),
      upsertLocalTx: (tx) =>
        set((s) => {
          const rest = s.localTxs.filter((t) => !(t.hash === tx.hash && t.networkId === tx.networkId));
          return { localTxs: [tx, ...rest].slice(0, 300) };
        }),
      toggleHideBalances: () => set((s) => ({ hideBalances: !s.hideBalances })),
      // Network choice and custom RPCs are device preferences, not wallet data:
      // creating or restoring a wallet must not silently move the user to another chain.
      reset: () => set((s) => ({ ...initial, networkId: s.networkId, customRpc: s.customRpc })),
    }),
    {
      name: 'qd-meta',
      version: 1,
      storage: createJSONStorage(() => {
        try {
          return localStorage;
        } catch {
          const mem = new Map<string, string>();
          return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
        }
      }),
    },
  ),
);

export function useSelectedAccount(): AccountMeta | undefined {
  return useMeta((s) => s.accounts.find((a) => a.index === s.selectedIndex) ?? s.accounts[0]);
}

/** Session-level (not persisted) vault status. */
interface SessionState {
  status: 'unknown' | 'no-vault' | 'locked' | 'unlocked';
  backedUp: boolean;
  apiOnline: boolean;
  set(p: Partial<Omit<SessionState, 'set'>>): void;
}

export const useSession = create<SessionState>()((set) => ({
  status: 'unknown',
  backedUp: true,
  apiOnline: true,
  set: (p) => set(p),
}));

export type ToastKind = 'success' | 'error' | 'info' | 'pending';
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>, ttlMs?: number): number;
  dismiss(id: number): void;
}

let toastSeq = 1;
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push(t, ttlMs = 3500) {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] });
    if (ttlMs > 0) setTimeout(() => get().dismiss(id), ttlMs);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

export const toast = {
  success: (title: string, description?: string) => useToasts.getState().push({ kind: 'success', title, ...(description ? { description } : {}) }),
  error: (title: string, description?: string) => useToasts.getState().push({ kind: 'error', title, ...(description ? { description } : {}) }, 5000),
  info: (title: string, description?: string) => useToasts.getState().push({ kind: 'info', title, ...(description ? { description } : {}) }),
};
