'use client';
import { ApiClient, ApiError } from '@qd/rpc';
import { BITCOIN_NETWORKS } from '@qd/blockchain';
import type { BitcoinAddressType, BitcoinNetwork } from '@qd/blockchain';
import type { ApiAccount, BitcoinNetworkName, ClientSecurityEventType } from '@qd/shared-types';
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

      // --- EVM address registration ---
      const evmRegistered = remote.addresses.some((a) => a.address.toLowerCase() === acc.address.toLowerCase());
      if (!evmRegistered) {
        const message = ApiClient.addressProofMessage(remote.id, acc.address, session.userId);
        const proof = await vault.call('signAddressProof', { index: acc.index, message });
        await api.registerAddress(remote.id, acc.address, proof);
      }

      // --- Bitcoin address registration ---
      await syncBitcoinAddresses(remote, acc.index, session.userId);
    }
    useSession.getState().set({ apiOnline: true });
  } catch {
    useSession.getState().set({ apiOnline: false });
  }
}

/**
 * Registers Bitcoin addresses for every Bitcoin network the wallet supports.
 * Called once per account inside syncWithBackend.
 *
 * The backend verification requires:
 *   message = "QDWallet-BTC|v1|{accountId}|{network}|{address}|{userId}"
 * which the KeyWorker's `signBtcAddressProof` validates and signs.
 */
async function syncBitcoinAddresses(
  remote: ApiAccount,
  hdIndex: number,
  userId: string,
): Promise<void> {
  const api = await getApi();
  const { btcAddressType } = useMeta.getState();

  for (const network of BITCOIN_NETWORKS) {
    const btcNetwork = network as BitcoinNetwork;
    const chain = btcNetwork.bitcoin.chain as BitcoinNetworkName;

    // Derive the address in the KeyWorker (cached after the first call).
    let address: string;
    try {
      const result = await vault.call('btcAddress', {
        index: hdIndex,
        network: chain,
        addressType: btcAddressType,
      });
      address = result.address;
    } catch {
      // If the wallet is locked between calls, skip silently — the next
      // syncWithBackend call (after unlock) will catch up.
      continue;
    }

    // Cache the address so hooks and UI can display it without another worker call.
    const cacheKey = `${btcNetwork.id}|${btcAddressType}|${hdIndex}`;
    useMeta.getState().setBtcAddress(cacheKey, address);

    // Skip if the backend already knows this address.
    const alreadyRegistered = remote.addresses.some(
      (a) => a.networkFamily === 'bitcoin' && a.address.toLowerCase() === address.toLowerCase(),
    );
    if (alreadyRegistered) continue;

    // Build and sign the fixed-format ownership-proof message.
    const message = btcAddressProofMessage(remote.id, chain, address, userId);
    let proof: string;
    try {
      const result = await vault.call('signBtcAddressProof', {
        index: hdIndex,
        network: chain,
        addressType: btcAddressType,
        message,
      });
      proof = result.proof;
    } catch {
      // The worker rejected the message (locked or format mismatch) — skip
      // this network; it will be retried on the next sync.
      continue;
    }

    try {
      await api.registerBtcAddress(remote.id, chain, address, btcAddressType as BitcoinAddressType, proof);
    } catch (e) {
      // 409 Conflict means the address is already registered — not an error.
      if (e instanceof ApiError && e.status === 409) continue;
      // Any other failure is non-fatal; the registration will retry on the
      // next sync. Swallow so it does not mark the whole sync as offline.
    }
  }
}

/**
 * Builds the Bitcoin address registration message the KeyWorker signs.
 * Must match BTC_PROOF_RE in key-worker.ts and BtcAddressRegistrationMessage
 * in the Go backend.
 *
 * Format: "QDWallet-BTC|v1|{accountId}|{network}|{address}|{userId}"
 */
export function btcAddressProofMessage(
  accountId: string,
  network: BitcoinNetworkName,
  address: string,
  userId: string,
): string {
  return `QDWallet-BTC|v1|${accountId}|${network}|${address}|${userId}`;
}

export async function reportEvent(type: ClientSecurityEventType): Promise<void> {
  try {
    await (await getApi()).reportSecurityEvent(type);
  } catch {
    /* offline: non-critical */
  }
}
