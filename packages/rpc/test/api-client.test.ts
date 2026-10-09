import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, JsonRpcError, generateDeviceKeyPair, proxyRequest, webCryptoDeviceKey } from '../src';

const ORIGIN = 'http://localhost:3000';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** In-memory fake of the wallet-api auth surface, verifying real P-256 signatures. */
function fakeApi(opts: { originInMessage?: string; knownDevice?: boolean } = {}) {
  const calls: Call[] = [];
  let pubKey: CryptoKey | undefined;
  let challenge: { id: string; message: string } | undefined;
  let deviceKnown = opts.knownDevice ?? false;
  let failNextWith401 = false;

  const reply = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  const session = { userId: 'u1', deviceId: 'd1', accessExpiresAt: new Date(Date.now() + 600_000).toISOString(), csrfToken: 'csrf-1' };

  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init?.headers as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, headers, body };
    calls.push(call);
    switch (url.pathname) {
      case '/v1/auth/refresh':
        return reply(401, { title: 'no', status: 401, code: 'UNAUTHENTICATED' });
      case '/v1/auth/challenge': {
        const der = Uint8Array.from(atob(body.devicePublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        pubKey = await crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const id = 'ch1';
        const message = `QDWallet-Auth|v1|${opts.originInMessage ?? ORIGIN}|${id}|nonce1|2026-01-01T00:00:00Z`;
        challenge = { id, message };
        return reply(200, { challengeId: id, nonce: 'nonce1', message, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      case '/v1/auth/login':
      case '/v1/auth/register': {
        const sig = Uint8Array.from(atob(body.signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey!, sig, new TextEncoder().encode(challenge!.message));
        if (!ok) return reply(401, { title: 'bad sig', status: 401, code: 'BAD_SIGNATURE' });
        if (url.pathname === '/v1/auth/login' && !deviceKnown) return reply(401, { title: 'unknown', status: 401, code: 'UNKNOWN_DEVICE' });
        deviceKnown = true;
        return reply(url.pathname === '/v1/auth/register' ? 201 : 200, session);
      }
      case '/v1/devices':
        if (failNextWith401) {
          failNextWith401 = false;
          return reply(401, { title: 'expired', status: 401, code: 'UNAUTHENTICATED' });
        }
        return reply(200, { devices: [] });
      case '/v1/rpc/evm/31337':
        if (body.method === 'eth_blockNumber') return reply(200, { jsonrpc: '2.0', id: body.id, result: '0x10' });
        return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not allowed' } });
      default:
        return reply(404, { title: 'nf', status: 404, code: 'NOT_FOUND' });
    }
  };
  return { f, calls, expire: () => (failNextWith401 = true) };
}

async function client(api: ReturnType<typeof fakeApi>) {
  return new ApiClient({
    baseUrl: 'http://api.test',
    clientType: 'web',
    platform: 'web',
    deviceKey: webCryptoDeviceKey(await generateDeviceKeyPair()),
    expectedOrigin: ORIGIN,
    fetch: api.f,
  });
}

describe('ApiClient', () => {
  it('registers a new device after login is rejected, with a verifiable signature', async () => {
    const api = fakeApi();
    const c = await client(api);
    const s = await c.ensureSession();
    expect(s.userId).toBe('u1');
    expect(api.calls.map((x) => x.path)).toEqual([
      '/v1/auth/refresh',
      '/v1/auth/challenge',
      '/v1/auth/login',
      '/v1/auth/challenge',
      '/v1/auth/register',
    ]);
    expect(api.calls.at(-1)!.body).toMatchObject({ platform: 'web' });
  });

  it('logs in a known device without registering', async () => {
    const api = fakeApi({ knownDevice: true });
    await (await client(api)).ensureSession();
    expect(api.calls.map((x) => x.path)).not.toContain('/v1/auth/register');
  });

  it('refuses to sign a challenge naming a different origin (phishing relay)', async () => {
    const api = fakeApi({ originInMessage: 'https://evil.example' });
    await expect((await client(api)).ensureSession()).rejects.toMatchObject({ code: 'BAD_CHALLENGE' });
    expect(api.calls.map((x) => x.path)).not.toContain('/v1/auth/login');
  });

  it('sends CSRF on unsafe requests and the client-type header everywhere', async () => {
    const api = fakeApi({ knownDevice: true });
    const c = await client(api);
    await c.rpc(31337, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const rpcCall = api.calls.find((x) => x.path === '/v1/rpc/evm/31337')!;
    expect(rpcCall.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(rpcCall.headers['X-QD-Client']).toBe('web');
    await c.devices();
    expect(api.calls.at(-1)!.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('re-authenticates once on 401 and retries', async () => {
    const api = fakeApi({ knownDevice: true });
    const c = await client(api);
    await c.ensureSession();
    api.expire();
    await expect(c.devices()).resolves.toEqual({ devices: [] });
  });

  it('surfaces JSON-RPC errors from the proxy', async () => {
    const api = fakeApi({ knownDevice: true });
    const req = proxyRequest(await client(api), 31337);
    await expect(req({ method: 'eth_blockNumber' })).resolves.toBe('0x10');
    await expect(req({ method: 'debug_traceTransaction' })).rejects.toBeInstanceOf(JsonRpcError);
  });

  it('builds the exact address-proof message', () => {
    expect(ApiClient.addressProofMessage('acc', '0xABC', 'user')).toBe('QDWallet-Address|v1|acc|0xabc|user');
    expect(new ApiError(404, 'NOT_FOUND').status).toBe(404);
  });
});
