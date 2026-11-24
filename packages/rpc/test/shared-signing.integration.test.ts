// END-TO-END over HTTP: three independent users (own device key, session,
// share store) run real key generation and the real networked three-round
// Threshold Raccoon protocol through wallet-api; the API combines and
// verifies the signature and its relayer executes it through the QdAccount
// smart contract on a real Anvil chain. Gated by QD_API_URL and ANVIL_URL:
//
//   anvil --port 8546 --chain-id 31337 &
//   (cd services/wallet-api && HTTP_ADDR=:8181 METRICS_ADDR=:9191 APP_ENV=development STORE=memory PRICE_PROVIDER=static \
//      DEV_CREDENTIAL_RATE_BURST=500 EVM_RPC_31337=anvil=http://127.0.0.1:8546 \
//      RELAYER_PRIVATE_KEY_31337=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d go run ./cmd/wallet-api) &
//   QD_API_URL=http://localhost:8181 ANVIL_URL=http://127.0.0.1:8546 npx vitest run test/shared-signing.integration.test.ts
//
// The relayer uses Anvil account #1; this test funds accounts from #0.
//
// Other chains (e.g. an Anvil fork of Sepolia, or Sepolia itself):
//   QD_CHAIN_ID=11155111   chain the proposals target (the API needs EVM_RPC_<id>
//                          and RELAYER_PRIVATE_KEY_<id>; ANVIL_URL is that chain's RPC)
//   QD_FUNDER_KEY=0x...    key that funds each new smart account (default Anvil #0)
//   QD_FUND_ETH=0.03       amount sent to each new smart account (default 1)
//   QD_ONLY_ACCEPTANCE=1   run only the acceptance test (saves testnet ETH)
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  QdParty,
  decodeKeyShare,
  decodeRound1,
  decodeRound2,
  decodeSignature,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  publicKeyHash,
  verify,
} from '@qd/qd-crypto';
import { QdShareStore, dealShares, generateRecipientKeyPair, openShareEnvelope, type Kv } from '@qd/wallet-core';
import { QdAccount, accountAddress, executionMessage, proposalCall } from '@qd/qd-account';
import {
  ApiClient,
  ApiError,
  checkKeygenAgainstWallet,
  checkSession,
  fromB64url,
  generateDeviceKeyPair,
  proposalDigest,
  sha256Hex,
  toB64url,
  transcriptHash,
  webCryptoDeviceKey,
  type MyEnvelope,
  type Proposal,
  type SigningSession,
} from '../src';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const API = env.QD_API_URL;
const ANVIL = env.ANVIL_URL;
const PASSWORD = 'integration test pw 1!';
const CHAIN_ID = Number(env.QD_CHAIN_ID ?? 31337);
const FUNDER = privateKeyToAccount((env.QD_FUNDER_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex);
const FUND = parseEther(env.QD_FUND_ETH ?? '1');
/** Public chains are slower: one-time setup is ~13 transactions at ~12 s each. */
const SLOW = CHAIN_ID !== 31337;
const TIMEOUT = (ms: number) => (SLOW ? ms * 4 : ms);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    del: async (k: string) => void m.delete(k),
  };
}

interface Device {
  name: string;
  api: ApiClient;
  shares: QdShareStore;
  participantId?: string;
  /** In-memory round state, as in the key worker. */
  parties: Map<string, { party: QdParty; sid: Uint8Array; act: number[] }>;
}

async function newDevice(name: string): Promise<Device> {
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  const api = new ApiClient({
    baseUrl: API!, clientType: 'mobile', platform: 'android', expectedOrigin: 'app:qdwallet',
    deviceKey: webCryptoDeviceKey(await generateDeviceKeyPair()), freshDevice: true,
    tokenStore: { get: async () => tokens, set: async (t) => void (tokens = t) },
  });
  const shares = new QdShareStore(memoryKv(), { kdf: { m: 256, t: 1, p: 1 }, allowWeakKdfForTests: true });
  await shares.unlock(PASSWORD);
  return { name, api, shares, parties: new Map() };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

/** Wallet with n participants, a completed key generation and one shared account with a registered address. */
async function initializedWallet(n: number) {
  const devices = await Promise.all(Array.from({ length: n }, (_, i) => newDevice(['ADHIL', 'NENA', 'P3', 'P4', 'P5'][i]!)));
  const owner = devices[0]!;
  const w = await owner.api.createSharedWallet('Signing test', owner.name);
  for (const d of devices.slice(1)) await d.api.acceptInvitation((await owner.api.createInvitation(w.id, d.name)).code, d.name);
  for (const d of devices) d.participantId = (await d.api.sharedWallet(w.id)).me.id;

  await owner.api.startKeyGeneration(w.id);
  for (const d of devices) {
    const kg = await d.api.currentKeyGeneration(w.id);
    checkKeygenAgainstWallet(await d.api.sharedWallet(w.id), kg);
    const kp = await generateRecipientKeyPair();
    await d.shares.putRecipientKey({ walletId: w.id, keygenId: kg.id, participantId: kg.me!.participantId, publicKey: toB64url(kp.publicKey) }, kp.privateKey);
    await d.api.registerEncryptionKey(w.id, kg, kp.publicKey);
  }
  const kg = await owner.api.currentKeyGeneration(w.id);
  const dealt = await dealShares({
    walletId: w.id, keygenId: kg.id, threshold: kg.threshold, parties: kg.parties, membershipVersion: kg.membershipVersion,
    recipients: kg.participants.map((p) => ({ participantId: p.participantId, partyIndex: p.partyIndex, publicKey: fromB64url(p.encryptionKey!) })),
  });
  await owner.api.uploadDeal(w.id, kg, dealt.fingerprint, dealt.envelopes);
  for (const d of devices) {
    const env2: MyEnvelope = await d.api.myKeygenEnvelope(w.id, kg.id);
    const ctx = {
      walletId: env2.walletId, keygenId: env2.keygenId, participantId: env2.participantId, partyIndex: env2.partyIndex,
      threshold: env2.threshold, parties: env2.parties, membershipVersion: env2.membershipVersion, fingerprint: env2.fingerprint,
    };
    const bytes = await openShareEnvelope(await d.shares.recipientPrivateKey(kg.id), ctx, { enc: fromB64url(env2.enc), ct: fromB64url(env2.ct) });
    await d.shares.putShare({ ...ctx, storedAt: new Date().toISOString() }, bytes);
    await d.shares.deleteRecipientKey(kg.id);
    await d.api.acknowledgeShare(w.id, env2);
  }
  expect((await owner.api.sharedWallet(w.id)).key.status).toBe('initialized');

  const acct = await owner.api.createSharedAccount(w.id, 'Treasury');
  // Every device derives pk_j from its own share; all must agree.
  let address = '';
  for (const d of devices) {
    const pk = new QdParty(decodeKeyShare(await d.shares.shareBytes(w.id))).publicKey(acct.derivationIndex);
    const h = `0x${hex(publicKeyHash(pk))}` as Hex;
    const addr = accountAddress(h).toLowerCase();
    const k = await d.api.registerAccountKey(w.id, acct, kg.id, encodePublicKey(pk), h, addr);
    expect(k.address).toBe(addr);
    address = addr;
  }
  return { walletId: w.id, devices, owner, account: acct, address: address as Address, keygenId: kg.id };
}

function chainClients() {
  const chain = defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ANVIL!] } } });
  return {
    pub: createPublicClient({ chain, transport: http(ANVIL) }),
    funder: createWalletClient({ chain, transport: http(ANVIL), account: FUNDER }),
  };
}

/**
 * One signer device's participation loop: what apps/web's signing hook and
 * key worker do, with the same checks, but the share is used in-process here.
 */
async function participate(d: Device, walletId: string, proposalId: string, opts: { stopAfterRound?: number } = {}): Promise<SigningSession> {
  const book = new Map<string, string>();
  for (let i = 0; i < 400; i++) {
    const p = await d.api.proposal(proposalId);
    if (!p.signing?.session) {
      if (p.lifecycle !== 'awaiting_signers') return Promise.reject(new Error(`unexpected lifecycle ${p.lifecycle}`));
      await d.api.startSigning(proposalId).catch((e) => { if (!(e instanceof ApiError)) throw e; });
      continue;
    }
    const s = await d.api.signingSession(p.signing.session.id);
    if (s.status === 'complete' || s.status === 'failed') return s;
    if (s.round < 1) {
      await sleep(300);
      continue;
    }
    const share = decodeKeyShare(await d.shares.shareBytes(walletId));
    const party = new QdParty(share);
    const pkHash = `0x${hex(publicKeyHash(party.publicKey(p.derivationIndex)))}`;
    expect(await proposalDigest(p)).toBe(p.digest);
    const addr = accountAddress(pkHash as Hex).toLowerCase();
    checkSession(s, {
      walletId, proposalId, proposalDigest: p.digest, chainId: p.chainId, derivationIndex: p.derivationIndex, accountAddress: addr,
      publicKeyHash: pkHash, message: executionMessage(BigInt(p.chainId), addr as Address, proposalCall(p)),
      signerPartyIndexes: p.signing.signerPartyIndexes!, keyGenerationId: s.keyGenerationId,
    });
    const round = s.round;
    const me = share.index;
    if (s.progress[String(round) as '1'].includes(me) || (opts.stopAfterRound !== undefined && round > opts.stopAfterRound)) {
      if (opts.stopAfterRound !== undefined && round > opts.stopAfterRound) return s;
      await sleep(300);
      continue;
    }
    const inputs = round === 1 ? [] : s.signerPartyIndexes.map((idx) => s.messages.find((m) => m.round === round - 1 && m.partyIndex === idx)!);
    for (const m of inputs) {
      expect(await sha256Hex(fromB64url(m.payload!))).toBe(m.payloadSha256);
      book.set(`${m.round}:${m.partyIndex}`, m.payloadSha256);
    }
    const transcript = await transcriptHash(s.header, [...book].map(([k, h]) => ({ round: +k.split(':')[0]!, partyIndex: +k.split(':')[1]!, payloadSha256: h })), round);
    expect(transcript).toBe(s.transcriptHash);
    let payload: Uint8Array;
    if (round === 1) {
      const sid = Uint8Array.from(s.sid.match(/../g)!.map((h) => parseInt(h, 16)));
      const r1 = party.round1({ sid, act: s.signerPartyIndexes, derivationIndex: s.derivationIndex, msg: Uint8Array.from(s.message.slice(2).match(/../g)!.map((h) => parseInt(h, 16))) });
      d.parties.set(s.id, { party, sid, act: s.signerPartyIndexes });
      payload = encodeRound1(r1);
    } else {
      const st = d.parties.get(s.id)!;
      const bytes = inputs.map((m) => fromB64url(m.payload!));
      payload = round === 2
        ? encodeRound2(st.party.round2(st.sid, bytes.map((b, k) => decodeRound1(st.act[k]!, b))), st.act)
        : encodeRound3(st.party.round3(st.sid, bytes.map((b, k) => decodeRound2(st.act[k]!, b, st.act))));
    }
    await d.api.submitRound(s, d.participantId!, me, round, payload, transcript);
  }
  throw new Error('signing did not finish');
}

async function waitLifecycle(d: Device, proposalId: string, want: string[], timeoutMs = TIMEOUT(180_000)): Promise<Proposal> {
  const end = Date.now() + timeoutMs;
  let p = await d.api.proposal(proposalId);
  while (!want.includes(p.lifecycle) && Date.now() < end) {
    await sleep(1000);
    p = await d.api.proposal(proposalId);
  }
  return p;
}

describe.skipIf(!API || !ANVIL)('networked Threshold Raccoon signing and execution (3 users, real crypto, Anvil)', () => {
  it('acceptance: 2-of-3 wallet sends 0.02 ETH — approvals, networked signing, verification, on-chain execution, receipt', async () => {
    const { pub, funder } = chainClients();
    const { walletId, devices, owner, address } = await initializedWallet(3);
    const [adhil, nena, p3] = devices as [Device, Device, Device];
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: address, value: FUND }) });
    const recipient = `0x${hex(crypto.getRandomValues(new Uint8Array(20)))}` as Address;

    const prop = await owner.api.createProposal(walletId, {
      accountId: (await owner.api.sharedWallet(walletId)).accounts[0]!.id, chainId: CHAIN_ID, to: recipient,
      valueWei: parseEther('0.02').toString(), nonce: 0, gasLimit: 21000, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
    });
    expect(prop.senderAddress).toBe(address);
    await adhil.api.voteOnProposal(prop.id, 'approve');
    expect((await adhil.api.proposal(prop.id)).lifecycle).toBe('awaiting_approvals');
    await nena.api.voteOnProposal(prop.id, 'approve');
    const approved = await adhil.api.proposal(prop.id);
    expect(approved.status).toBe('approved');
    expect(approved.lifecycle).toBe('awaiting_signers');
    expect(approved.signing!.signerPartyIndexes).toEqual([1, 2]);

    // A participant that is not selected cannot open or join the session.
    expect(await code(p3.api.startSigning(prop.id))).toBe('NOT_SELECTED_SIGNER');

    // ADHIL and NENA sign concurrently, as independent devices, through the coordinator.
    const [sa, sb] = await Promise.all([participate(adhil, walletId, prop.id), participate(nena, walletId, prop.id)]);
    expect(sa.status).toBe('complete');
    expect(sb.id).toBe(sa.id);
    const done = await adhil.api.signingSession(sa.id, true);
    expect(done.signatureVerified).toBe(true);
    // Independent verification on a device, against its own derived pk_j.
    const pk = new QdParty(decodeKeyShare(await p3.shares.shareBytes(walletId))).publicKey(approved.derivationIndex);
    const msg = Uint8Array.from(done.message.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
    expect(verify(pk, msg, decodeSignature(fromB64url(done.signature!)))).toBe(true);
    const altered = msg.slice();
    altered[0]! ^= 1;
    expect(verify(pk, altered, decodeSignature(fromB64url(done.signature!)))).toBe(false);
    // Exactly one signature: starting again returns the completed session, never a new one.
    const again = await nena.api.startSigning(prop.id);
    expect(again.id).toBe(sa.id);
    expect(again.status).toBe('complete');
    expect(again.signatureSha256).toBe(done.signatureSha256);

    const before = await pub.getBalance({ address: recipient });
    const final = await waitLifecycle(adhil, prop.id, ['confirmed', 'execution_failed']);
    expect(final.lifecycle).toBe('confirmed');
    if (final.execution.status === 'not_started') throw new Error('no execution');
    const receipt = await pub.getTransactionReceipt({ hash: final.execution.txHash as Hex });
    expect(receipt.status).toBe('success');
    expect(receipt.blockNumber).toBe(BigInt(final.execution.blockNumber!));
    expect(await pub.getBalance({ address: recipient })).toBe(before + parseEther('0.02'));
    expect(await pub.getBalance({ address })).toBe(FUND - parseEther('0.02'));
    expect(await pub.readContract({ address, abi: QdAccount.abi, functionName: 'nonce' })).toBe(1n);
    console.log('acceptance tx', final.execution.txHash, 'gas', final.execution.gasUsed, 'block', final.execution.blockNumber);
    if (env.QD_REPORT_FILE) {
      const fsModule: string = 'node:fs'; // the package has no Node types; the test runs under Node
      const { writeFileSync } = (await import(/* @vite-ignore */ fsModule)) as { writeFileSync: (p: string, d: string) => void };
      writeFileSync(env.QD_REPORT_FILE, JSON.stringify({
        chainId: CHAIN_ID, account: address, recipient, relayer: final.execution.relayer, txHash: final.execution.txHash,
        blockNumber: final.execution.blockNumber, gasUsed: final.execution.gasUsed, effectiveGasPrice: final.execution.effectiveGasPrice,
        txNonce: final.execution.txNonce, setupTxs: final.execution.setupTxs, signers: approved.signing!.signerPartyIndexes,
        recipientBefore: before.toString(), recipientAfter: (await pub.getBalance({ address: recipient })).toString(),
        accountFunded: FUND.toString(), accountAfter: (await pub.getBalance({ address })).toString(),
      }, null, 2));
    }
  }, TIMEOUT(300_000));

  it.skipIf(env.QD_ONLY_ACCEPTANCE === '1')('dropout and safe retry; reverted call; replayed nonce', async () => {
    const { pub, funder } = chainClients();
    const { walletId, devices, owner, address } = await initializedWallet(3);
    const [a, b] = devices as [Device, Device, Device];
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: address, value: FUND }) });
    const accountId = (await owner.api.sharedWallet(walletId)).accounts[0]!.id;
    const propose = (input: { to: string; valueWei: string; data?: string; nonce: number; gasLimit?: number }) =>
      owner.api.createProposal(walletId, {
        accountId, chainId: CHAIN_ID, data: '0x', gasLimit: 21000, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', ...input,
      });

    // Dropout: B stops after round 1 and its device reports lost state; the session fails, never succeeds.
    const p1 = await propose({ to: FUNDER.address, valueWei: '1000', nonce: 0 });
    await a.api.voteOnProposal(p1.id, 'approve');
    await b.api.voteOnProposal(p1.id, 'approve');
    const partial = await Promise.all([
      participate(a, walletId, p1.id, { stopAfterRound: 1 }),
      participate(b, walletId, p1.id, { stopAfterRound: 1 }),
    ]);
    expect(partial[0].round).toBe(2);
    await b.api.abortSigning(partial[1], b.participantId!, 'signer_state_lost');
    const failed = await a.api.proposal(p1.id);
    expect(failed.lifecycle).toBe('signing_failed');
    expect(failed.execution.status).toBe('not_started');
    // Messages for a failed session are refused.
    expect(await code(a.api.submitRound(partial[0], a.participantId!, 1, 2, new Uint8Array(10), '00'))).toMatch(/SIGNING_SESSION_CLOSED|ROUND_MESSAGE_INVALID/);
    // Retry: new session, new sid; both devices complete it.
    const retry = await a.api.startSigning(p1.id);
    expect(retry.attempt).toBe(2);
    expect(retry.sid).not.toBe(partial[0].sid);
    a.parties.clear();
    b.parties.clear();
    const [r1] = await Promise.all([participate(a, walletId, p1.id), participate(b, walletId, p1.id)]);
    expect(r1.status).toBe('complete');
    expect((await waitLifecycle(a, p1.id, ['confirmed', 'execution_failed'])).lifecycle).toBe('confirmed');

    // A call that reverts: the account consumes the nonce, reports success = false, moves no value.
    const p2 = await propose({ to: address, valueWei: '0', data: '0xdeadbeef', nonce: 1, gasLimit: 100000 });
    await a.api.voteOnProposal(p2.id, 'approve');
    await b.api.voteOnProposal(p2.id, 'approve');
    await Promise.all([participate(a, walletId, p2.id), participate(b, walletId, p2.id)]);
    const reverted = await waitLifecycle(a, p2.id, ['confirmed', 'execution_failed']);
    expect(reverted.lifecycle).toBe('execution_failed');
    if (reverted.execution.status === 'not_started') throw new Error('no execution');
    expect(reverted.execution.callSuccess).toBe(false);
    expect(reverted.execution.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Replay protection: another approved proposal reusing a spent nonce fails before any transaction is sent.
    const p3 = await propose({ to: FUNDER.address, valueWei: '1', nonce: 1 });
    await a.api.voteOnProposal(p3.id, 'approve');
    await b.api.voteOnProposal(p3.id, 'approve');
    await Promise.all([participate(a, walletId, p3.id), participate(b, walletId, p3.id)]);
    const replay = await waitLifecycle(a, p3.id, ['confirmed', 'execution_failed']);
    expect(replay.lifecycle).toBe('execution_failed');
    if (replay.execution.status === 'not_started') throw new Error('no execution');
    expect(replay.execution.lastError).toMatch(/nonce 1 was already used/);
    expect(replay.execution.txHash).toBe('');
    expect(await pub.readContract({ address, abi: QdAccount.abi, functionName: 'nonce' })).toBe(2n);
  }, TIMEOUT(400_000));

  it.skipIf(env.QD_ONLY_ACCEPTANCE === '1')('unfunded shared account: waits without spending relayer gas, executes once funded; relayer diagnostics', async () => {
    const { pub, funder } = chainClients();
    const { walletId, devices, owner, address } = await initializedWallet(3);
    const [a, b] = devices as [Device, Device, Device];
    const status = (await owner.api.relayerStatus()).chains.find((c) => c.chainId === CHAIN_ID)!;
    expect(status.relayerConfigured).toBe(true);
    expect(status.rpcOk).toBe(true);
    expect(status.rpcChainId).toBe(CHAIN_ID);
    expect(status.relayerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(status)).not.toMatch(/[0-9a-f]{64}/i); // no key material
    const value = parseEther('0.001');
    const prop = await owner.api.createProposal(walletId, {
      accountId: (await owner.api.sharedWallet(walletId)).accounts[0]!.id, chainId: CHAIN_ID, to: FUNDER.address,
      valueWei: value.toString(), nonce: 0, gasLimit: 21000, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
    });
    await a.api.voteOnProposal(prop.id, 'approve');
    await b.api.voteOnProposal(prop.id, 'approve');
    await Promise.all([participate(a, walletId, prop.id), participate(b, walletId, prop.id)]);
    const waiting = await waitLifecycle(a, prop.id, ['insufficient_account_funds', 'confirmed', 'execution_failed']);
    expect(waiting.lifecycle).toBe('insufficient_account_funds');
    if (waiting.execution.status === 'not_started') throw new Error('no execution');
    expect(waiting.execution.lastError.toLowerCase()).toContain(address.toLowerCase());
    // Nothing was spent for this account: no setup transaction, the account is not deployed.
    expect(waiting.execution.setupTxs).toEqual([]);
    expect(await pub.getCode({ address })).toBeUndefined();
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: address, value }) });
    const done = await waitLifecycle(a, prop.id, ['confirmed', 'execution_failed']);
    expect(done.lifecycle).toBe('confirmed');
    if (done.execution.status === 'not_started') throw new Error('no execution');
    expect(done.execution.executedTo).toBe(FUNDER.address.toLowerCase());
    expect(done.execution.executedValue).toBe(value.toString());
    expect(done.execution.txNonce).toBeTypeOf('number');
    expect(done.execution.blockTime).toBeTruthy();
    expect(await pub.getBalance({ address })).toBe(0n);
  }, TIMEOUT(400_000));

  it.skipIf(env.QD_ONLY_ACCEPTANCE === '1')('histories from blockchain data: shared Wallet History and personal Activity, same hashes, failures, no duplicates', async () => {
    const { pub, funder } = chainClients();
    const network = CHAIN_ID === 31337 ? 'anvil' : CHAIN_ID === 11155111 ? 'sepolia' : String(CHAIN_ID);
    const chain = defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ANVIL!] } } });
    const eventually = async <T>(fn: () => Promise<T | undefined>, what: string, ms = TIMEOUT(60_000)): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(1_000);
      }
    };
    // Personal wallets: an address registered with a proof signed by its key; nothing else is ever sent by the client.
    async function personal(name: string) {
      const d = await newDevice(name);
      const key = privateKeyToAccount(generatePrivateKey());
      const { userId } = await d.api.ensureSession();
      const w = await d.api.createWallet(name, `w-${name}-${crypto.randomUUID()}`);
      const a = await d.api.createAccount(w.id, 0, 'Main', `a-${name}-${crypto.randomUUID()}`);
      await d.api.registerAddress(a.id, key.address, await key.signMessage({ message: ApiClient.addressProofMessage(a.id, key.address, userId) }));
      const client = createWalletClient({ chain, transport: http(ANVIL), account: key });
      return { d, address: key.address.toLowerCase() as Address, accountId: a.id, client };
    }
    const activity = async (u: { d: Device; accountId: string }) => (await u.d.api.activity(u.accountId, network)).items;

    // Two shared wallets (A pays; B receives) and two personal users (Alice offline throughout; Bob active).
    const A = await initializedWallet(3);
    const B = await initializedWallet(3);
    const alice = await personal('ALICE');
    const bob = await personal('BOB');
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: A.address, value: FUND }) });
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: bob.address, value: parseEther('1') }) });

    const [a1, a2] = A.devices as [Device, Device, Device];
    const accountId = (await A.owner.api.sharedWallet(A.walletId)).accounts[0]!.id;
    async function execute(to: string, valueWei: bigint, nonce: number, data = '0x', gasLimit = 21000) {
      const p = await A.owner.api.createProposal(A.walletId, {
        accountId, chainId: CHAIN_ID, to, valueWei: valueWei.toString(), data, nonce, gasLimit, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
      });
      await a1.api.voteOnProposal(p.id, 'approve');
      await a2.api.voteOnProposal(p.id, 'approve');
      a1.parties.clear();
      a2.parties.clear();
      await Promise.all([participate(a1, A.walletId, p.id), participate(a2, A.walletId, p.id)]);
      const done = await waitLifecycle(a1, p.id, ['confirmed', 'execution_failed']);
      if (done.execution.status === 'not_started') throw new Error('no execution');
      return { proposal: p, lifecycle: done.lifecycle, txHash: done.execution.txHash.toLowerCase() };
    }

    // 1. Shared → Personal: 0.02 ETH to Alice (who never opens her wallet meanwhile).
    const toAlice = await execute(alice.address, parseEther('0.02'), 0);
    expect(toAlice.lifecycle).toBe('confirmed');
    // 2. Personal → Shared: Bob sends 0.01 ETH to A.
    const bobToA = (await pub.waitForTransactionReceipt({ hash: await bob.client.sendTransaction({ to: A.address, value: parseEther('0.01') }) })).transactionHash.toLowerCase();
    // 3. Personal → Personal: Bob sends 0.003 ETH to Alice.
    const bobToAlice = (await pub.waitForTransactionReceipt({ hash: await bob.client.sendTransaction({ to: alice.address, value: parseEther('0.003') }) })).transactionHash.toLowerCase();
    // 4. Shared → Shared: A sends 0.005 ETH to B.
    const aToB = await execute(B.address, parseEther('0.005'), 1);
    expect(aToB.lifecycle).toBe('confirmed');
    // Failures: a reverted outer transaction (Bob calls A with junk data) and an execution whose call reverts.
    const bobFailed = await bob.client.sendTransaction({ to: A.address, data: '0xdeadbeef', gas: 100_000n });
    const bobFailedRc = await pub.waitForTransactionReceipt({ hash: bobFailed });
    expect(bobFailedRc.status).toBe('reverted');
    const innerFail = await execute(A.address, 0n, 2, '0xdeadbeef', 100_000);
    expect(innerFail.lifecycle).toBe('execution_failed');

    // 6–8. Alice opens her wallet later: Activity shows both incoming transfers, from the chain.
    const aliceItems = await eventually(async () => {
      const items = await activity(alice);
      return items.some((i) => i.hash === toAlice.txHash) && items.some((i) => i.hash === bobToAlice) ? items : undefined;
    }, 'Alice activity');
    const fromShared = aliceItems.find((i) => i.hash === toAlice.txHash)!;
    expect(fromShared).toMatchObject({ direction: 'in', from: A.address, to: alice.address, amount: parseEther('0.02').toString(), status: 'confirmed', networkId: network });
    expect(fromShared.fee).toBeUndefined(); // the gas service account paid, not Alice
    expect(aliceItems.find((i) => i.hash === bobToAlice)).toMatchObject({ direction: 'in', from: bob.address, amount: parseEther('0.003').toString() });

    // 7. Shared Wallet History of A.
    const histA = await eventually(async () => {
      const h = await A.owner.api.sharedWalletHistory(A.walletId, CHAIN_ID);
      return h.items.some((i) => i.txHash === innerFail.txHash) && h.items.some((i) => i.txHash === bobFailed.toLowerCase()) ? h : undefined;
    }, 'wallet A history');
    const sent = histA.items.find((i) => i.txHash === toAlice.txHash)!;
    // 9. Same transaction hash in both histories.
    expect(sent).toMatchObject({ direction: 'sent', kind: 'qd_execute', from: A.address, to: alice.address, amount: parseEther('0.02').toString(), success: true, proposalId: toAlice.proposal.id });
    expect(sent.gasUsed).toBeGreaterThan(0);
    expect(BigInt(sent.feeWei)).toBe(BigInt(sent.gasUsed) * BigInt(sent.gasPriceWei));
    expect(histA.items.find((i) => i.txHash === bobToA)).toMatchObject({ direction: 'received', kind: 'native', from: bob.address, amount: parseEther('0.01').toString(), success: true });
    expect(histA.items.find((i) => i.txHash === aToB.txHash)).toMatchObject({ direction: 'sent', to: B.address, amount: parseEther('0.005').toString(), success: true });
    // 12. Failed transactions are never successful.
    expect(histA.items.find((i) => i.txHash === bobFailed.toLowerCase())).toMatchObject({ success: false, kind: 'native', from: bob.address });
    expect(histA.items.find((i) => i.txHash === innerFail.txHash)).toMatchObject({ success: false, kind: 'qd_execute', proposalId: innerFail.proposal.id });
    // History is scoped to this wallet: B's or the personal users' other transactions are not in it.
    expect(histA.items.some((i) => i.txHash === bobToAlice)).toBe(false);
    // B received from A, same hash; B's members only.
    const histB = await B.owner.api.sharedWalletHistory(B.walletId, CHAIN_ID);
    expect(histB.items.find((i) => i.txHash === aToB.txHash)).toMatchObject({ direction: 'received', from: A.address, to: B.address, success: true });
    expect(histB.items.some((i) => i.txHash === toAlice.txHash)).toBe(false);
    expect(await code(alice.d.api.sharedWalletHistory(A.walletId, CHAIN_ID))).toBe('NOT_FOUND');

    // Bob's Activity: his sends and his failed transaction (failed, with the fee he paid).
    const bobItems = await activity(bob);
    expect(bobItems.find((i) => i.hash === bobToA)).toMatchObject({ direction: 'out', to: A.address, status: 'confirmed' });
    const bf = bobItems.find((i) => i.hash === bobFailed.toLowerCase())!;
    expect(bf.status).toBe('failed');
    expect(BigInt(bf.fee!)).toBe(bobFailedRc.gasUsed * bobFailedRc.effectiveGasPrice);

    // 11. Repeated synchronisation never duplicates.
    const counts = async () => [
      (await A.owner.api.sharedWalletHistory(A.walletId, CHAIN_ID)).items.length,
      (await activity(alice)).length,
      (await activity(bob)).length,
    ];
    const first = await counts();
    await sleep(3_000);
    expect(await counts()).toEqual(first);
    const keys = (await A.owner.api.sharedWalletHistory(A.walletId, CHAIN_ID)).items.map((i) => `${i.txHash}:${i.logIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    console.log('history hashes', { toAlice: toAlice.txHash, bobToA, bobToAlice, aToB: aToB.txHash, bobFailed, innerFail: innerFail.txHash, walletA: A.walletId });
    if (env.QD_HISTORY_REPORT) {
      const fsModule: string = 'node:fs';
      const { writeFileSync } = (await import(/* @vite-ignore */ fsModule)) as { writeFileSync: (p: string, d: string) => void };
      writeFileSync(env.QD_HISTORY_REPORT, JSON.stringify({ toAlice: toAlice.txHash, bobToA, bobToAlice, aToB: aToB.txHash, bobFailed, innerFail: innerFail.txHash, alice: alice.address, A: A.address, B: B.address, counts: first }, null, 2));
    }
  }, TIMEOUT(600_000));
});
