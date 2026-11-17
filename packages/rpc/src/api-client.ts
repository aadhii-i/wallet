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
import {
  prepareVoteMessage,
  type CreateProposalInput,
  type Proposal,
  type SharedAccount,
  type SharedWallet,
  type VoteDecision,
} from './shared-wallets';
import {
  KeygenRefusedError,
  envelopeHashHex,
  envelopesDigestHex,
  fromB64url,
  keygenAckMessage,
  keygenDealMessage,
  keygenKeyMessage,
  toB64url,
  type KeyGeneration,
  type KeygenFailReason,
  type MyEnvelope,
} from './shared-keygen';
import {
  accountKeyMessage,
  signAbortMessage,
  signRoundMessage,
  type AccountKeyInfo,
  type RelayerChainStatus,
  type GasEstimate,
  type WalletHistory,
  type GasHistory,
  type SigningAbortReason,
  type SigningSession,
} from './shared-signing';

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

  // ---------- shared wallets ----------

  sharedWallets() {
    return this.json<{ wallets: SharedWallet[] }>('GET', '/v1/shared-wallets');
  }
  sharedWallet(id: string) {
    return this.json<SharedWallet>('GET', `/v1/shared-wallets/${encodeURIComponent(id)}`);
  }
  createSharedWallet(name: string, displayName: string) {
    return this.json<SharedWallet>('POST', '/v1/shared-wallets', { name, displayName });
  }
  createInvitation(walletId: string, label: string) {
    return this.json<{ id: string; code: string; label: string; status: string; expiresAt: string }>(
      'POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/invitations`, { label });
  }
  revokeInvitation(walletId: string, invitationId: string) {
    return this.json<void>('POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/invitations/${encodeURIComponent(invitationId)}/revoke`);
  }
  previewInvitation(code: string) {
    return this.json<{ walletId: string; walletName: string; invitedBy: string; activeParticipants: number; expiresAt: string }>(
      'POST', '/v1/shared-wallet-invitations/preview', { code });
  }
  acceptInvitation(code: string, displayName: string) {
    return this.json<SharedWallet>('POST', '/v1/shared-wallet-invitations/accept', { code, displayName });
  }
  rejectInvitation(code: string) {
    return this.json<void>('POST', '/v1/shared-wallet-invitations/reject', { code });
  }
  revokeParticipant(walletId: string, participantId: string) {
    return this.json<{ membershipVersion: number; keyStatus: string }>(
      'POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/participants/${encodeURIComponent(participantId)}/revoke`);
  }
  createSharedAccount(walletId: string, name: string) {
    return this.json<SharedAccount>('POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/accounts`, { name });
  }
  createProposal(walletId: string, input: CreateProposalInput) {
    return this.json<Proposal>('POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/proposals`, input);
  }
  proposals(walletId: string) {
    return this.json<{ proposals: Proposal[] }>('GET', `/v1/shared-wallets/${encodeURIComponent(walletId)}/proposals`);
  }
  proposal(id: string) {
    return this.json<Proposal>('GET', `/v1/proposals/${encodeURIComponent(id)}`);
  }

  /**
   * Approve or reject with this device's key. Re-fetches the proposal, verifies
   * its digest locally (prepareVoteMessage), and only then signs.
   */
  async voteOnProposal(proposalId: string, decision: VoteDecision): Promise<Proposal> {
    const p = await this.proposal(proposalId);
    const n = await this.json<{ nonce: string; participantId: string; expiresAt: string }>(
      'POST', `/v1/proposals/${encodeURIComponent(proposalId)}/vote-nonce`);
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = await prepareVoteMessage(p, decision, n.participantId, n.nonce, issuedAt);
    const signature = b64url(await this.opts.deviceKey.sign(new TextEncoder().encode(message)));
    return this.json<Proposal>('POST', `/v1/proposals/${encodeURIComponent(proposalId)}/votes`, {
      decision, nonce: n.nonce, issuedAt, digest: p.digest, signature,
    });
  }

  // ---------- shared-wallet key generation (trusted dealer) ----------

  private keygenPath(walletId: string, keygenId?: string, rest = ''): string {
    const base = `/v1/shared-wallets/${encodeURIComponent(walletId)}/key-generations`;
    return keygenId ? `${base}/${encodeURIComponent(keygenId)}${rest}` : base;
  }

  private async deviceSign(message: string): Promise<string> {
    return b64url(await this.opts.deviceKey.sign(new TextEncoder().encode(message)));
  }

  startKeyGeneration(walletId: string) {
    return this.json<KeyGeneration>('POST', this.keygenPath(walletId));
  }
  currentKeyGeneration(walletId: string) {
    return this.json<KeyGeneration>('GET', `${this.keygenPath(walletId)}/current`);
  }

  /** Registers this device's X-Wing public key for its party slot, signed with the device key. */
  async registerEncryptionKey(walletId: string, kg: KeyGeneration, publicKey: Uint8Array) {
    if (!kg.me) throw new KeygenRefusedError('This participant is not part of the key generation');
    const message = await keygenKeyMessage(walletId, kg, kg.me.participantId, kg.me.partyIndex, publicKey);
    return this.json<KeyGeneration>('POST', this.keygenPath(walletId, kg.id, '/encryption-key'), {
      publicKey: toB64url(publicKey), signature: await this.deviceSign(message),
    });
  }

  /**
   * Dealer: uploads every envelope (one request each, so each stays under the
   * body limit), then commits them with a device signature over the hashes it
   * computed itself.
   */
  async uploadDeal(
    walletId: string,
    kg: KeyGeneration,
    fingerprint: string,
    envelopes: { participantId: string; partyIndex: number; enc: Uint8Array; ct: Uint8Array }[],
  ) {
    const hashed = [];
    for (const e of envelopes) {
      await this.json<void>('PUT', this.keygenPath(walletId, kg.id, `/envelopes/${encodeURIComponent(e.participantId)}`), {
        fingerprint, enc: toB64url(e.enc), ct: toB64url(e.ct),
      });
      hashed.push({ partyIndex: e.partyIndex, participantId: e.participantId, hashHex: await envelopeHashHex(e.enc, e.ct) });
    }
    const message = keygenDealMessage(walletId, kg, fingerprint, await envelopesDigestHex(hashed));
    return this.json<KeyGeneration>('POST', this.keygenPath(walletId, kg.id, '/commit'), {
      fingerprint, signature: await this.deviceSign(message),
    });
  }

  myKeygenEnvelope(walletId: string, keygenId: string) {
    return this.json<MyEnvelope>('GET', this.keygenPath(walletId, keygenId, '/envelope'));
  }

  /**
   * Call only after the key worker decrypted, verified and stored the share.
   * The envelope hash is recomputed locally rather than taken from the server.
   */
  async acknowledgeShare(walletId: string, envelope: MyEnvelope) {
    const hash = await envelopeHashHex(fromB64url(envelope.enc), fromB64url(envelope.ct));
    if (hash !== envelope.envelopeHash) throw new KeygenRefusedError('Envelope hash mismatch');
    return this.json<KeyGeneration>('POST', this.keygenPath(walletId, envelope.keygenId, '/acknowledge'), {
      fingerprint: envelope.fingerprint, signature: await this.deviceSign(keygenAckMessage(envelope, hash)),
    });
  }

  failKeyGeneration(walletId: string, keygenId: string, reason: KeygenFailReason) {
    return this.json<KeyGeneration>('POST', this.keygenPath(walletId, keygenId, '/fail'), { reason });
  }

  // ---- networked Threshold Raccoon signing --------------------------------

  /** Registers (or attests) pk_j computed by this device's key worker. */
  async registerAccountKey(walletId: string, account: { id: string; derivationIndex: number }, keygenId: string, publicKey: Uint8Array, publicKeyHash: string, address: string) {
    const message = accountKeyMessage(walletId, account.id, account.derivationIndex, keygenId, publicKeyHash, address);
    return this.json<AccountKeyInfo>('POST', `/v1/shared-wallets/${encodeURIComponent(walletId)}/accounts/${encodeURIComponent(account.id)}/key`, {
      publicKey: toB64url(publicKey), signature: await this.deviceSign(message),
    });
  }

  accountKey(walletId: string, accountId: string) {
    return this.json<AccountKeyInfo>('GET', `/v1/shared-wallets/${encodeURIComponent(walletId)}/accounts/${encodeURIComponent(accountId)}/key`);
  }

  /** Opens the proposal's signing session (or returns the open one). Selected signers only. */
  startSigning(proposalId: string) {
    return this.json<SigningSession>('POST', `/v1/proposals/${encodeURIComponent(proposalId)}/signing-sessions`, {});
  }

  signingSession(sessionId: string, allPayloads = false) {
    return this.json<SigningSession>('GET', `/v1/signing-sessions/${encodeURIComponent(sessionId)}${allPayloads ? '?payloads=all' : ''}`);
  }

  /** Relays this signer's round message, device-signed over the transcript it computed itself. */
  async submitRound(session: SigningSession, participantId: string, partyIndex: number, round: number, payload: Uint8Array, transcript: string) {
    const message = await signRoundMessage(session.id, round, partyIndex, participantId, transcript, payload);
    return this.json<SigningSession>('POST', `/v1/signing-sessions/${encodeURIComponent(session.id)}/rounds/${round}`, {
      payload: toB64url(payload), transcriptHash: transcript, signature: await this.deviceSign(message),
    });
  }

  async abortSigning(session: SigningSession, participantId: string, reason: SigningAbortReason) {
    return this.json<SigningSession>('POST', `/v1/signing-sessions/${encodeURIComponent(session.id)}/abort`, {
      reason, signature: await this.deviceSign(signAbortMessage(session.id, participantId, reason)),
    });
  }

  /** Relayer diagnostics per chain: RPC, relayer address and balance, contracts. Public, no key material. */
  async relayerStatus(opts: { refresh?: boolean } = {}) {
    return this.json<{ chains: RelayerChainStatus[] }>('GET', `/v1/relayers${opts.refresh ? '?refresh=1' : ''}`, undefined, { auth: false });
  }

  /** Gas needed to execute a proposal now, both balances and whether it can proceed (members only; read-only). */
  async gasEstimate(proposalId: string) {
    return this.json<GasEstimate>('GET', `/v1/proposals/${encodeURIComponent(proposalId)}/gas-estimate`);
  }

  /** A shared wallet's own transaction history on one chain, from the chain index (members only). */
  async sharedWalletHistory(walletId: string, chainId: number) {
    return this.json<WalletHistory>('GET', `/v1/shared-wallets/${encodeURIComponent(walletId)}/history?chainId=${chainId}`);
  }

  /** Gas service account history on one chain: recharges and gas payments, from chain receipts. */
  async gasHistory(chainId: number, limit = 200) {
    return this.json<GasHistory>('GET', `/v1/gas-service/${chainId}/history?limit=${limit}`);
  }
}
