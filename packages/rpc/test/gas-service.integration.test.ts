// READ-ONLY check of the Gas Service Account against a live chain (e.g.
// public Sepolia): the API's status and history must agree with what the
// chain itself reports, read independently through the authenticated RPC
// proxy. Sends no transactions. Gated by QD_GAS_API_URL:
//
//   QD_GAS_API_URL=http://localhost:8383 QD_CHAIN_ID=11155111 npx vitest run test/gas-service.integration.test.ts
import { describe, expect, it } from 'vitest';
import { ApiClient, generateDeviceKeyPair, proxyRequest, webCryptoDeviceKey, type GasHistory } from '../src';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const API = env.QD_GAS_API_URL;
const CHAIN_ID = Number(env.QD_CHAIN_ID ?? 11155111);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function client(): Promise<ApiClient> {
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  return new ApiClient({
    baseUrl: API!, clientType: 'mobile', platform: 'android', expectedOrigin: 'app:qdwallet',
    deviceKey: webCryptoDeviceKey(await generateDeviceKeyPair()), freshDevice: true,
    tokenStore: { get: async () => tokens, set: async (t) => void (tokens = t) },
  });
}

describe.skipIf(!API)('Gas Service Account on a live chain (read-only)', () => {
  it('status and history match the chain', async () => {
    const api = await client();
    const cs = (await api.relayerStatus({ refresh: true })).chains.find((c) => c.chainId === CHAIN_ID);
    expect(cs, `chain ${CHAIN_ID} not reported`).toBeTruthy();
    expect(cs!.rpcOk && cs!.rpcChainId === CHAIN_ID && cs!.relayerConfigured).toBe(true);
    expect(JSON.stringify(cs)).not.toMatch(/private|https?:\/\//i);
    const rpc = proxyRequest(api, CHAIN_ID);

    // Balance: the API's figure is the chain's (read again independently; it may only have changed by mined activity).
    const onChain = BigInt((await rpc({ method: 'eth_getBalance', params: [cs!.relayerAddress, 'latest'] })) as string);
    expect(BigInt(cs!.relayerBalanceWei!)).toBe(onChain);
    expect(['healthy', 'low', 'insufficient']).toContain(cs!.health);
    const base = BigInt((await rpc({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as { baseFeePerGas: string }).baseFeePerGas);
    expect(BigInt(cs!.baseFeeWei!)).toBeGreaterThan(0n);
    expect(BigInt(cs!.baseFeeWei!) * 2n + 10n).toBeGreaterThanOrEqual(base); // same order as the chain's latest base fee
    console.info('[gas] status', {
      address: cs!.relayerAddress, balanceWei: cs!.relayerBalanceWei, health: cs!.health, gasPriceWei: cs!.gasPriceWei,
      executionCostWei: cs!.executionCostWei, newWalletCostWei: cs!.newWalletCostWei, executionsCovered: cs!.executionsCovered,
      verifierDeployed: cs!.verifierDeployed, factoryDeployed: cs!.factoryDeployed,
    });

    // History: wait for the monitor's backfill to reach the head.
    let h: GasHistory | null = null;
    for (let i = 0; i < 30; i++) {
      h = await api.gasHistory(CHAIN_ID);
      if (h.scannedThroughBlock && cs!.blockNumber && h.scannedThroughBlock >= cs!.blockNumber - 10) break;
      await sleep(5_000);
    }
    expect(h!.address.toLowerCase()).toBe(cs!.relayerAddress!.toLowerCase());
    console.info('[gas] history', { since: h!.historyAvailableSinceBlock, through: h!.scannedThroughBlock, entries: h!.transfers.length });
    for (const t of h!.transfers) {
      console.info('[gas]', t.direction, t.kind, t.txHash, t.blockNumber, t.valueWei, t.feeWei, t.success);
      if (t.txHash.startsWith('internal:')) continue;
      // Every entry is a real mined transaction with these exact facts.
      const rc = (await rpc({ method: 'eth_getTransactionReceipt', params: [t.txHash] })) as {
        status: string; blockNumber: string; gasUsed: string; effectiveGasPrice: string; from: string; to: string | null;
      };
      expect(rc).toBeTruthy();
      expect(Number(BigInt(rc.blockNumber))).toBe(t.blockNumber);
      expect(rc.status === '0x1').toBe(t.success);
      const self = cs!.relayerAddress!.toLowerCase();
      if (t.direction === 'out') {
        expect(rc.from.toLowerCase()).toBe(self);
        expect(BigInt(t.feeWei)).toBe(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice));
      } else {
        expect(rc.to?.toLowerCase()).toBe(self);
      }
    }
  }, 240_000);
});
