import type {
  ActivityItem,
  ApiAccount,
  ApiAddress,
  ApiNetwork,
  ApiTransaction,
  ApiWallet,
  Challenge,
  ClientSecurityEventType,
  Device,
  Platform,
  PricesResponse,
  Problem,
  SecurityEvent,
  Session,
} from '@qd/shared-types';

/**
 * Device authentication key (spec §22). On web: WebCrypto P-256, non-extractable,
 * persisted as a CryptoKey in IndexedDB. Used only for API auth, never for chains.
 */
export interface DeviceKey {
  /** SPKI DER bytes. */
  publicKeySpki(): Promise<Uint8Array>;
  /** ECDSA P-256 / SHA-256 over `message`; IEEE P1363 (r||s, 64 bytes). */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem?: Problem,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  clientType: 'web' | 'mobile';
  platform: Platform;
  deviceKey: DeviceKey;
  /** Origin the challenge message must name (window.location.origin, or `app:qdwallet`). */
  expectedOrigin: string;
  deviceLabel?: string;
  /**
   * True when the device key was just created. Any existing session cookie then
   * belongs to a previous device, so it must not be adopted via refresh.
   */
  freshDevice?: boolean;
  fetch?: typeof fetch;
  /** Mobile only: secure token persistence (SecureStore). */
  tokenStore?: {
    get(): Promise<{ accessToken: string; refreshToken: string } | null>;
    set(t: { accessToken: string; refreshToken: string } | null): Promise<void>;
  };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Typed client for wallet-api. Handles device-key login/registration, cookie or
 * bearer sessions, CSRF headers and one transparent re-auth on 401.
 */
export class ApiClient {
  private csrfToken: string | undefined;
  private session: Session | undefined;
  private authInFlight: Promise<Session> | undefined;
  private readonly f: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.f = opts.fetch ?? ((...args) => fetch(...args));
  }

  get currentSession(): Session | undefined {
    return this.session;
  }

  /** Ensures a valid session exists: refresh → login → register. */
  async ensureSession(): Promise<Session> {
    if (this.session && Date.parse(this.session.accessExpiresAt) - Date.now() > 30_000) return this.session;
    this.authInFlight ??= this.authenticate().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  private async authenticate(): Promise<Session> {
    const skipRefresh = this.opts.freshDevice === true && !this.session;
    this.opts.freshDevice = false;
    const refreshed = skipRefresh ? null : await this.tryRefresh();
    if (refreshed) return this.adopt(refreshed);
    try {
      return this.adopt(await this.challengeAndSubmit('/v1/auth/login'));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        return this.adopt(await this.challengeAndSubmit('/v1/auth/register'));
      }
      throw e;
    }
  }

  private async tryRefresh(): Promise<Session | null> {
    let body: string | undefined;
    if (this.opts.clientType === 'mobile') {
      const t = await this.opts.tokenStore?.get();
      if (!t) return null;
      body = JSON.stringify({ refreshToken: t.refreshToken });
    }
    const res = await this.raw('POST', '/v1/auth/refresh', body, { auth: false });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  }

  private async challengeAndSubmit(path: '/v1/auth/login' | '/v1/auth/register'): Promise<Session> {
    const spki = await this.opts.deviceKey.publicKeySpki();
    const ch = await this.json<Challenge>('POST', '/v1/auth/challenge', { devicePublicKey: b64url(spki) }, { auth: false });
    this.assertChallenge(ch);
    const signature = b64url(await this.opts.deviceKey.sign(new TextEncoder().encode(ch.message)));
    const payload =
      path === '/v1/auth/register'
        ? { challengeId: ch.challengeId, signature, platform: this.opts.platform, label: this.opts.deviceLabel ?? 'Web browser' }
        : { challengeId: ch.challengeId, signature };
    return this.json<Session>('POST', path, payload, { auth: false });
  }

  /** Refuse to sign anything that is not a fresh auth challenge for our origin (anti-phishing). */
  private assertChallenge(ch: Challenge): void {
    const expectedPrefix = `QDWallet-Auth|v1|${this.opts.expectedOrigin}|${ch.challengeId}|${ch.nonce}|`;
    const parts = ch.message.split('|');
    if (!ch.message.startsWith(expectedPrefix) || parts.length !== 6) {
      throw new ApiError(400, 'BAD_CHALLENGE');
    }
    if (Date.parse(ch.expiresAt) < Date.now()) throw new ApiError(400, 'CHALLENGE_EXPIRED');
  }

  private async adopt(s: Session): Promise<Session> {
    this.session = s;
    if (s.csrfToken) this.csrfToken = s.csrfToken;
    if (this.opts.clientType === 'mobile' && s.accessToken && s.refreshToken) {
      await this.opts.tokenStore?.set({ accessToken: s.accessToken, refreshToken: s.refreshToken });
    }
    return s;
  }

  async logout(): Promise<void> {
    try {
      await this.json('POST', '/v1/auth/logout');
    } finally {
      this.session = undefined;
      this.csrfToken = undefined;
      await this.opts.tokenStore?.set(null);
    }
  }

  // ---------- transport ----------

  private async raw(method: string, path: string, body: string | undefined, o: { auth: boolean; headers?: Record<string, string> }): Promise<Response> {
    const headers: Record<string, string> = { 'X-QD-Client': this.opts.clientType, ...o.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.auth && UNSAFE.has(method) && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    if (this.opts.clientType === 'mobile' && o.auth) {
      const t = this.session?.accessToken ?? (await this.opts.tokenStore?.get())?.accessToken;
      if (t) headers.Authorization = `Bearer ${t}`;
    }
    return this.f(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      credentials: this.opts.clientType === 'web' ? 'include' : 'omit',
      cache: 'no-store',
    });
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    o: { auth?: boolean; idempotencyKey?: string } = {},
  ): Promise<T> {
    const auth = o.auth ?? true;
    if (auth) await this.ensureSession();
    const headers: Record<string, string> = o.idempotencyKey ? { 'Idempotency-Key': o.idempotencyKey } : {};
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res = await this.raw(method, path, payload, { auth, headers });
    if (res.status === 401 && auth) {
      this.session = undefined;
      await this.ensureSession();
      res = await this.raw(method, path, payload, { auth, headers });
    }
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as Problem | undefined;
      throw new ApiError(res.status, problem?.code ?? `HTTP_${res.status}`, problem);
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  }

  // ---------- endpoints ----------

  networks() {
    return this.json<{ networks: ApiNetwork[] }>('GET', '/v1/networks', undefined, { auth: false });
  }
  prices(ids: string[]) {
    return this.json<PricesResponse>('GET', `/v1/prices?ids=${encodeURIComponent(ids.join(','))}`, undefined, { auth: false });
  }
  devices() {
    return this.json<{ devices: Device[] }>('GET', '/v1/devices');
  }
  renameDevice(id: string, label: string) {
    return this.json<Device>('PATCH', `/v1/devices/${id}`, { label });
  }
  revokeDevice(id: string) {
    return this.json<void>('DELETE', `/v1/devices/${id}`);
  }
  wallets() {
    return this.json<{ wallets: ApiWallet[] }>('GET', '/v1/wallets');
  }
  createWallet(label: string, idempotencyKey: string) {
    return this.json<ApiWallet>('POST', '/v1/wallets', { label }, { idempotencyKey });
  }
  createAccount(walletId: string, hdIndex: number, name: string, idempotencyKey: string) {
    return this.json<ApiAccount>('POST', `/v1/wallets/${walletId}/accounts`, { hdIndex, name }, { idempotencyKey });
  }
  updateAccount(accountId: string, patch: { name?: string; hidden?: boolean }) {
    return this.json<ApiAccount>('PATCH', `/v1/accounts/${accountId}`, patch);
  }
  registerAddress(accountId: string, address: string, proof: string) {
    return this.json<ApiAddress>('PUT', `/v1/accounts/${accountId}/addresses`, { networkFamily: 'evm', address, proof });
  }
  activity(accountId: string, network: string, cursor?: string) {
    const q = new URLSearchParams({ network, ...(cursor ? { cursor } : {}) });
    return this.json<{ items: ActivityItem[]; nextCursor?: string }>('GET', `/v1/accounts/${accountId}/activity?${q}`);
  }
  trackTransaction(t: {
    networkId: string;
    hash: string;
    accountId: string;
    from: string;
    to: string;
    assetId: string;
    amount: string;
    nonce?: number;
  }) {
    return this.json<ApiTransaction>('POST', '/v1/transactions', t, { idempotencyKey: `${t.networkId}:${t.hash}` });
  }
  transaction(id: string) {
    return this.json<ApiTransaction>('GET', `/v1/transactions/${id}`);
  }
  securityEvents() {
    return this.json<{ events: SecurityEvent[] }>('GET', '/v1/security/events');
  }
  reportSecurityEvent(type: ClientSecurityEventType) {
    return this.json<void>('POST', '/v1/security/client-events', { type });
  }

  /** Message the address-ownership proof must sign (openapi: registerAddress). */
  static addressProofMessage(accountId: string, address: string, userId: string): string {
    return `QDWallet-Address|v1|${accountId}|${address.toLowerCase()}|${userId}`;
  }

  /** JSON-RPC over the authenticated proxy. Provider keys never reach the client. */
  async rpc(chainId: number, body: unknown): Promise<unknown> {
    return this.json<unknown>('POST', `/v1/rpc/evm/${chainId}`, body);
  }
}
