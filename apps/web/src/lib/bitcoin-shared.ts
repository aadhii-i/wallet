import {
  BITCOIN_TESTNET4_GENESIS,
  bitcoinPolicyId,
  sharedBitcoinOutput,
  verifyPreviousOutput,
  type BitcoinSharedPolicy,
  type SharedBitcoinCoin,
  type SharedBitcoinProposal,
  validateSharedBitcoinProposal,
} from '@qd/bitcoin';
import { bytesToHex } from '@qd/wallet-core';
import { getApi } from './api';
import { createBitcoinDataSource } from './bitcoin-api';
import { vault } from './vault-client';

export async function checkSharedBitcoinNetwork(): Promise<void> {
  if ((await (await getApi()).btcIdentity('testnet4')).genesis !== BITCOIN_TESTNET4_GENESIS)
    throw new Error('Bitcoin network identity mismatch');
}

/** A confirmed, locally reserved coin is unavailable for a conflicting proposal. */
export async function discoverSharedBitcoin(policy: BitcoinSharedPolicy) {
  bitcoinPolicyId(policy);
  await checkSharedBitcoinNetwork();
  const source = createBitcoinDataSource('testnet4');
  const plan = await vault.call('btcSharedPlan', { policy });
  const paths: { branch: 0 | 1; index: number; address: string }[] = [
    { branch: 0, index: 0, address: sharedBitcoinOutput(policy, 0, 0).address },
  ];
  let highestUsed = -1,
    empty = 0;
  for (let i = 0; i < 10000; i++) {
    const address = sharedBitcoinOutput(policy, 1, i).address;
    const used = await source.isAddressUsed!(address);
    if (used) {
      highestUsed = i;
      empty = 0;
    } else empty++;
    if (used || i < plan.next) paths.push({ branch: 1, index: i, address });
    if (empty >= 20 && i >= plan.next - 1) break;
  }
  const updated = await vault.call('btcSharedPlan', { policy, highestUsed });
  const unavailable = new Set(updated.unavailable),
    coins: SharedBitcoinCoin[] = [], allCoins: SharedBitcoinCoin[] = [];
  let total = 0n;
  for (const path of paths) {
    for (const coin of await source.getUtxos(path.address)) {
      total += coin.value;
      allCoins.push({...coin, branch:path.branch, addressIndex:path.index});
      if (!unavailable.has(`${coin.txid.toLowerCase()}:${coin.vout}`))
        coins.push({ ...coin, branch: path.branch, addressIndex: path.index });
    }
  }
  return {
    coins,
    allCoins,
    total,
    next: updated.next,
    addresses: paths.map(path => path.address),
    available: coins.filter((c) => c.confirmations > 0).reduce((n, c) => n + c.value, 0n),
  };
}

export async function hydrateSharedBitcoinCoins(coins: SharedBitcoinCoin[]): Promise<SharedBitcoinCoin[]> {
  if (coins.length > 100) throw new Error('Select at most 100 Bitcoin inputs for one payment');
  const source = createBitcoinDataSource('testnet4'),
    previous = new Map<string, string>(),
    result: SharedBitcoinCoin[] = [];
  for (const coin of coins) {
    if (coin.confirmations < 1) continue;
    if (!previous.has(coin.txid)) previous.set(coin.txid, await source.getRawTransaction!(coin.txid));
    const verified = { ...coin, previousTx: previous.get(coin.txid)! };
    verifyPreviousOutput(verified);
    result.push(verified);
  }
  return result;
}

export async function recheckSharedBitcoinProposal(
  policy: BitcoinSharedPolicy,
  proposal: SharedBitcoinProposal,
  saved = false,
): Promise<void> {
  await checkSharedBitcoinNetwork();
  const tx = validateSharedBitcoinProposal(policy, proposal, saved ? Math.min(Date.now(), proposal.expiresAt - 1) : Date.now()),
    source = createBitcoinDataSource('testnet4');
  const cache = new Map<string, Awaited<ReturnType<typeof source.getUtxos>>>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i),
      path = proposal.inputPaths[i]!,
      address = sharedBitcoinOutput(policy, path.branch, path.index).address;
    if (!cache.has(address)) cache.set(address, await source.getUtxos(address));
    const current = cache.get(address)!.find((c) => c.txid === bytesToHex(input.txid!) && c.vout === input.index);
    if (!current || current.confirmations < 1 || current.value !== input.witnessUtxo!.amount)
      throw new Error('A shared Bitcoin input is no longer confirmed and unspent');
    verifyPreviousOutput({ ...current, previousTx: await source.getRawTransaction!(current.txid) });
  }
}
