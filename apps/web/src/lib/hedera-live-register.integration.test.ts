/**
 * LIVE backend registration (skipped unless HEDERA_LIVE_REGISTER=1).
 *
 * Drives the real wallet-api through the existing `ApiClient`:
 *   1. Register/login a device (P-256 device key + challenge signature).
 *   2. Ensure a wallet + account exist for the new user.
 *   3. Register the already-created Hedera account against the account,
 *      passing the wallet-derived Hedera public key. The backend verifies
 *      ownership via the Mirror Node.
 *   4. Read the account's HBAR balance through the backend.
 *
 * Node's fetch has no cookie jar, so we wrap it to persist Set-Cookie values and
 * inject the Origin header the browser would send automatically.
 *
 * Env:
 *   HEDERA_LIVE_REGISTER=1
 *   HEDERA_ACCOUNT_ID=0.0.x        (default 0.0.11473349)
 *   API_URL=http://localhost:8080
 *   WEB_ORIGIN=http://localhost:3000
 */
import { describe, it, expect } from 'vitest';
import { ApiClient, generateDeviceKeyPair, webCryptoDeviceKey } from '@qd/rpc';
import { HDKeyring } from '@qd/wallet-core';

const RUN = process.env.HEDERA_LIVE_REGISTER === '1';
const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const TARGET_ACCOUNT = process.env.HEDERA_ACCOUNT_ID ?? '0.0.11473349';
const MNEMONIC = 'test test test test test test test test test test test junk';

function cookieJarFetch(): typeof fetch {
  const jar = new Map<string, string>();
  const wrapped = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    headers.set('Origin', ORIGIN);
    if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(input, { ...init, headers });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const [k, ...rest] = (pair ?? '').split('=');
      if (k) jar.set(k.trim(), rest.join('='));
    }
    return res;
  };
  return wrapped as unknown as typeof fetch;
}

describe.skipIf(!RUN)('Hedera backend registration (live)', () => {
  it('registers the verified account and reads its HBAR balance', async () => {
    const pair = await generateDeviceKeyPair();
    const api = new ApiClient({
      baseUrl: API_URL,
      clientType: 'web',
      platform: 'web',
      deviceKey: webCryptoDeviceKey(pair),
      expectedOrigin: ORIGIN,
      deviceLabel: 'live-integration',
      freshDevice: true,
      fetch: cookieJarFetch(),
    });

    const session = await api.ensureSession();
    console.log('[auth] device registered; session fields:', Object.keys(session).join(', '));

    // Ensure a wallet + account exist for this new user.
    let wallets = await api.wallets();
    if (wallets.wallets.length === 0) {
      const wallet = await api.createWallet('Live Integration', crypto.randomUUID());
      await api.createAccount(wallet.id, 0, 'Account 1', crypto.randomUUID());
      wallets = await api.wallets();
    }
    const account = wallets.wallets.flatMap((w) => w.accounts)[0];
    expect(account).toBeTruthy();
    const hdIndex = account!.hdIndex ?? 0;
    console.log('[wallet] using account:', account!.id, 'hdIndex:', hdIndex);

    // Derive the wallet's Hedera public key (same key the on-chain account uses).
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const walletPubKey = keyring.hederaPublicKey(hdIndex);
    console.log('[key] derived Hedera pubkey:', walletPubKey);

    // Register — the backend verifies ownership via the Mirror Node.
    const address = await api.registerHederaAddress(account!.id, TARGET_ACCOUNT, walletPubKey);
    console.log('[register] address record:', JSON.stringify(address));
    expect(address.address).toBe(TARGET_ACCOUNT);
    expect(address.networkFamily).toBe('hedera');

    // Read balance through the backend.
    const balance = await api.hederaBalance(TARGET_ACCOUNT);
    console.log('[balance] backend balance:', JSON.stringify(balance));
    expect(balance.accountId).toBe(TARGET_ACCOUNT);

    console.log('\n=== REGISTRATION SUCCESS (backend verified via Mirror Node) ===');
    console.log('Hedera account :', TARGET_ACCOUNT);
    console.log('Wallet pubkey  :', walletPubKey);
    console.log('Balance (hbar) :', balance.hbar);
  }, 120_000);
});
