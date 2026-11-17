// Starts a throwaway Anvil (real EVM node) for a test file and deploys the QD
// contracts through the deterministic CREATE2 deployer, exactly as the API's
// relayer does on a fresh chain. Tests skip (and say why) when Anvil is absent.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CREATE2_DEPLOYER,
  deployerCalldata,
  factoryAddress,
  factoryInitCode,
  verifierAddress,
  verifierInitCode,
} from '../src';

export function anvilBinary(): string | null {
  const candidates = [process.env.ANVIL_BIN, join(homedir(), '.foundry', 'bin', 'anvil')].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const path = (process.env.PATH ?? '').split(':').map((d) => join(d, 'anvil'));
  return path.find((p) => existsSync(p)) ?? null;
}

/** Anvil's well-known account #0. A public test key: only ever used against a local Anvil. */
export const ANVIL_KEY_0: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_KEY_1: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export interface Anvil {
  url: string;
  chainId: number;
  stop: () => void;
  publicClient: ReturnType<typeof createPublicClient>;
  wallet: ReturnType<typeof createWalletClient>;
  test: ReturnType<typeof createTestClient>;
}

export async function startAnvil(chainId = 31337): Promise<Anvil> {
  const bin = anvilBinary();
  if (!bin) throw new Error('anvil not found');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn(bin, ['--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: chainId,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(url) });
  for (let i = 0; ; i++) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallet = createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(ANVIL_KEY_0) });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(url) });
  return { url, chainId, stop: () => proc.kill('SIGKILL'), publicClient, wallet, test };
}

export async function deployContracts(a: Anvil): Promise<void> {
  for (const [initCode, expected] of [
    [verifierInitCode(), verifierAddress()],
    [factoryInitCode(), factoryAddress()],
  ] as const) {
    if (await a.publicClient.getCode({ address: expected })) continue;
    const hash = await a.wallet.sendTransaction({
      to: CREATE2_DEPLOYER, data: deployerCalldata(initCode), account: a.wallet.account!, chain: a.wallet.chain,
    });
    const r = await a.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success' || !(await a.publicClient.getCode({ address: expected }))) {
      throw new Error(`deployment to ${expected} failed`);
    }
  }
}
