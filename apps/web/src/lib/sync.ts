'use client';
import { ApiClient, ApiError } from '@qd/rpc';
import type { ClientSecurityEventType } from '@qd/shared-types';
import { getApi } from './api';
import { vault } from './vault-client';
import { useMeta, useSession } from './store';

/**
 * Best-effort registration of public wallet metadata with wallet-api (spec §14.5).
 * The wallet stays fully usable if this fails; the UI shows an offline hint.
 */
export async function syncWithBackend(): Promise<void> {
  try {
    const api = await getApi();
    const session = await api.ensureSession();
    const meta = useMeta.getState();

    let walletId = meta.walletApiId;
    const { wallets } = await api.wallets();
    const existing = wallets.find((w) => w.id === walletId) ?? wallets[0];
    if (existing) walletId = existing.id;
    else walletId = (await api.createWallet('My wallet', crypto.randomUUID())).id;
    useMeta.getState().setWalletApiId(walletId);

    const remoteAccounts = existing?.accounts ?? [];
    for (const acc of useMeta.getState().accounts) {
      let remote = remoteAccounts.find((r) => r.hdIndex === acc.index);
      if (!remote) {
        try {
          remote = await api.createAccount(walletId, acc.index, acc.name, `acct-${walletId}-${acc.index}`);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          remote = (await api.wallets()).wallets.find((w) => w.id === walletId)?.accounts.find((r) => r.hdIndex === acc.index);
        }
      }
      if (!remote) continue;
      useMeta.getState().setAccountApiId(acc.index, remote.id);
      const registered = remote.addresses.some((a) => a.address.toLowerCase() === acc.address.toLowerCase());
      if (!registered) {
        const message = ApiClient.addressProofMessage(remote.id, acc.address, session.userId);
        const proof = await vault.call('signAddressProof', { index: acc.index, message });
        await api.registerAddress(remote.id, acc.address, proof);
      }
    }
    useSession.getState().set({ apiOnline: true });
  } catch {
    useSession.getState().set({ apiOnline: false });
  }
}

export async function reportEvent(type: ClientSecurityEventType): Promise<void> {
  try {
    await (await getApi()).reportSecurityEvent(type);
  } catch {
    /* offline: non-critical */
  }
}
