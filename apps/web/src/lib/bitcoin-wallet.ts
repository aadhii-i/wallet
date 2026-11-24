import type { BitcoinAddressType, BitcoinChain } from '@qd/blockchain';
import type { BitcoinDataSource, BitcoinWalletScope } from '@qd/bitcoin';
import { vault } from './vault-client';
import { BITCOIN_GAP, BITCOIN_SCAN_LIMIT } from './bitcoin-ledger';

/** Discovery never treats an upstream error as an unused address. */
export function bitcoinWalletScope(
  account: number,
  network: BitcoinChain,
  addressType: BitcoinAddressType,
  source: BitcoinDataSource,
): BitcoinWalletScope {
  let cached:
    | { root: string; allocated: number; at: number; result: Awaited<ReturnType<BitcoinWalletScope['discover']>> }
    | undefined;
  let pending: Promise<Awaited<ReturnType<BitcoinWalletScope['discover']>>> | undefined;
  const discover = async () => {
    const { address: root } = await vault.call('btcAddress', { index: account, network, addressType });
    const plan = await vault.call('btcChangePlan', { account, network, addressType });
    if (cached?.root === root && cached.allocated === plan.index && Date.now() - cached.at < 30_000)
      return cached.result;
    if (pending) return pending;
    pending = (async () => {
      const addresses: { address: string; changeIndex?: number }[] = [{ address: root }];
      let empty = 0,
        highestUsed = -1;
      for (let start = 0; start < BITCOIN_SCAN_LIMIT; start += BITCOIN_GAP) {
        const batch = await vault.call('btcChangeAddresses', {
          account,
          start,
          count: BITCOIN_GAP,
          network,
          addressType,
        });
        for (const entry of batch) {
          const used = source.isAddressUsed
            ? await source.isAddressUsed(entry.address)
            : (await source.getHistory(entry.address)).items.length > 0;
          if (used) {
            highestUsed = entry.changeIndex;
            empty = 0;
          } else empty++;
          if (used || entry.changeIndex < plan.index) addresses.push(entry);
          if (empty >= BITCOIN_GAP && entry.changeIndex >= plan.index - 1) {
            await vault.call('btcChangePlan', { account, network, addressType, highestUsed });
            const result = { addresses, highestUsed };
            cached = { root, allocated: Math.max(plan.index, highestUsed + 1), at: Date.now(), result };
            return result;
          }
        }
      }
      throw new Error('Bitcoin discovery limit reached; an extended recovery scan is required');
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
  return {
    discover,
    async change() {
      await discover();
      const { address, index } = await vault.call('btcChangePlan', { account, network, addressType });
      return { address, index };
    },
    async unavailable() {
      return new Set((await vault.call('btcChangePlan', { account, network, addressType })).unavailable);
    },
  };
}
