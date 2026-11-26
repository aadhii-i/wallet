/** Shared Hedera custody boundary. Imported only by the key worker. */
import * as H from '@qd/hedera';
import {
  type HDKeyring,
  type ConfirmationRegistry,
  type QdShareStore,
  type ShareInfo,
  bytesToHex,
  wipe,
} from '@qd/wallet-core';
import {
  QdParty,
  decodeKeyShare,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  decodeRound1,
  decodeRound2,
  type KeyShare,
} from '@qd/qd-crypto';
import { openKv } from './idb';
import type { VaultOps } from './vault-protocol';

export interface HederaRecord {
  plan: H.HederaPlan;
  message: string;
  proposal?: H.HederaProposal;
  consent?: H.HederaConsent;
  partial?: H.HederaPartial;
  approval?: H.HederaApproval;
  rotation?: {
    source: H.HederaProposal;
    sourceApproval: H.HederaApproval;
    target: H.HederaProposal;
    targetApproval: H.HederaApproval;
  };
  payerIndex?: number;
  createdAccountId?: string;
  raw?: string;
  status: 'pending' | 'confirmed' | 'failed' | 'expired';
}
export interface HederaState {
  version: 1;
  accountId?: string;
  records: Record<string, HederaRecord>;
}
type Deps = {
  kv?: ReturnType<typeof openKv>;
  unlocked: () => { keyring: HDKeyring; confirmations: ConfirmationRegistry };
  store: QdShareStore;
  requireShares: () => void;
  burn: (sid: string) => Promise<void>;
  usedSids: () => Promise<string[]>;
  mergeSids: (sids: string[]) => Promise<void>;
  touch: () => void;
};
const wipeKey = (key: KeyShare) => {
  key.share.forEach((p) => p.fill(0));
  key.seedsOut.forEach((p) => p.fill(0));
  key.seedsIn.forEach((p) => p.fill(0));
  key.chaincode.fill(0);
};
const initial = (): HederaState => ({ version: 1, records: {} });
const snapshotTime = (value: string) => {
  if (!/^\d+\.\d{1,9}$/.test(value)) throw new Error('Invalid mirror timestamp');
  const [s, n] = value.split('.');
  return BigInt(s!) * 1000000000n + BigInt(n!.padEnd(9, '0'));
};
function available(state: HederaState, account: H.HederaAccountInfo, except?: string): bigint {
  let held = 0n;
  for (const [id, record] of Object.entries(state.records))
    if (
      id !== except &&
      (record.plan.kind === 'transfer' ||
        (record.plan.kind === 'keyUpdate' &&
          (record.plan as H.HederaProposal).approvalPolicyId === record.plan.policyId)) &&
      record.status === 'pending'
    )
      held += BigInt(record.plan.amount) + BigInt(record.plan.maxFee);
  return BigInt(account.tinybars) - held;
}
type Names = Extract<keyof VaultOps, `hShared${string}`>;
type Handlers = { [K in Names]: (args: VaultOps[K]['req']) => Promise<VaultOps[K]['res']> };
export function createHederaWorker(deps: Deps) {
  const kv = deps.kv ?? openKv('qd-hedera-shared');
  const states = new Map<
    string,
    { party: QdParty; key: KeyShare; message: string; sid: string; expiresAt: number; stage: 1 | 2 }
  >();
  const scope = (id: string) => `v1|${deps.unlocked().keyring.evmAddress(0)}|${id}`;
  const stateKey = (id: string) => `state|${scope(id)}`;
  const policyKey = (id: string) => `policy|${scope(id)}`;
  const load = async (id: string) => (await kv.get<HederaState>(stateKey(id))) ?? initial();
  function consume(id: string, message: string, confirmation: VaultOps['hSharedPin']['req']['confirmation']) {
    deps.unlocked().confirmations.consume(confirmation, { kind: 'hedera-shared', policyId: id, message });
  }
  async function material(policy: H.HederaSharedPolicy, pinned = true) {
    deps.unlocked();
    deps.requireShares();
    deps.touch();
    for (const [key, state] of states)
      if (state.expiresAt <= Date.now()) {
        wipeKey(state.key);
        states.delete(key);
      }
    const id = H.hederaPolicyId(policy);
    if (pinned && !(await kv.get(policyKey(id)))) throw new Error('Compare and confirm the Hedera policy first');
    const slot = pinned ? `hedera:${id}` : policy.context.walletId,
      info = await deps.store.shareInfo(slot);
    if (
      !info ||
      info.keygenId !== policy.context.keygenId ||
      info.membershipVersion !== policy.context.membershipVersion ||
      info.threshold !== policy.raccoonThreshold ||
      info.parties !== policy.members.length
    )
      throw new Error('Hedera policy does not match this device’s Raccoon share');
    const member = policy.members.find((m) => m.partyIndex === info.partyIndex);
    if (
      !member ||
      member.participantId !== info.participantId ||
      member.publicKey !== deps.unlocked().keyring.hederaSharedPublicKey(policy.context)
    )
      throw new Error('This wallet is not the enrolled Hedera signer');
    const bytes = await deps.store.shareBytes(slot);
    let key: KeyShare;
    try {
      key = decodeKeyShare(bytes);
    } finally {
      wipe(bytes);
    }
    const party = new QdParty(key);
    if (H.hederaWireText(encodePublicKey(party.publicKey(policy.derivationIndex))) !== policy.raccoonPublicKey) {
      wipeKey(key);
      throw new Error('Raccoon key mismatch');
    }
    return { id, info, member, key, party };
  }
  async function approved(policy: H.HederaSharedPolicy, p: H.HederaProposal) {
    const message = bytesToHex(H.hederaSharedMessage(policy, p)),
      record = (await load(H.hederaPolicyId(policy))).records[p.id];
    if (!record?.consent || record.message !== message || record.status !== 'pending')
      throw new Error('Review and approve this exact Hedera payment first');
    return { message, record };
  }
  async function checkedAccount(policy: H.HederaSharedPolicy, account: H.HederaAccountInfo, from: string) {
    H.verifyHederaAccount(policy, account, from);
    H.verifyHederaSnapshotFresh(account);
    const state = await load(H.hederaPolicyId(policy));
    if (state.accountId !== from) throw new Error('Confirm this shared Hedera account on this device');
    return state;
  }
  async function checkedProposalAccount(
    policy: H.HederaSharedPolicy,
    p: H.HederaProposal,
    account: H.HederaAccountInfo,
  ) {
    if (p.kind === 'transfer') return checkedAccount(policy, account, p.from);
    H.validateHederaProposal(policy, p);
    H.verifyHederaAccount(p.sourcePolicy!, account, p.from);
    H.verifyHederaSnapshotFresh(account);
    const state = await load(H.hederaPolicyId(policy));
    if (p.approvalPolicyId === p.policyId && state.accountId !== p.from)
      throw new Error('Confirm the source account before key rotation');
    if (p.approvalPolicyId !== p.policyId && state.accountId && state.accountId !== p.from)
      throw new Error('Target policy is already bound to another account');
    return state;
  }
  const handlers: Handlers = {
    async hSharedEnroll({ context, participantId, derivationIndex }) {
      deps.unlocked();
      deps.requireShares();
      deps.touch();
      const info = await deps.store.shareInfo(context.walletId);
      if (
        context.network !== 'testnet' ||
        !info ||
        info.keygenId !== context.keygenId ||
        info.membershipVersion !== context.membershipVersion ||
        info.participantId !== participantId
      )
        throw new Error('Shared Hedera enrollment context mismatch');
      const bytes = await deps.store.shareBytes(context.walletId);
      let key: KeyShare;
      try {
        key = decodeKeyShare(bytes);
      } finally {
        wipe(bytes);
      }
      try {
        const entry = {
          ...context,
          participantId,
          partyIndex: info.partyIndex,
          derivationIndex,
          threshold: info.threshold,
          parties: info.parties,
          publicKey: deps.unlocked().keyring.hederaSharedPublicKey(context),
          raccoonPublicKey: H.hederaWireText(encodePublicKey(new QdParty(key).publicKey(derivationIndex))),
        };
        return deps
          .unlocked()
          .keyring.withHederaSharedPrivateKey(context, (privateKey) => H.signHederaEnrollment(entry, privateKey));
      } finally {
        wipeKey(key);
      }
    },
    async hSharedPin({ policy, confirmation }) {
      const m = await material(policy, false);
      try {
        consume(m.id, m.id, confirmation);
        await deps.store.archiveHederaShare(m.id, policy.context.walletId);
        await kv.set(policyKey(m.id), policy);
        return { policyId: m.id };
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedBind({ policy, account, confirmation }) {
      const m = await material(policy);
      try {
        H.verifyHederaAccount(policy, account);
        consume(m.id, `bind:${account.accountId}`, confirmation);
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial();
          if (state.accountId && state.accountId !== account.accountId)
            throw new Error('A different Hedera account is already pinned');
          return { ...state, accountId: account.accountId };
        });
        return { accountId: account.accountId };
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedStatus({ policy }) {
      const m = await material(policy);
      try {
        return await load(m.id);
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedApprove({ policy, proposal: p, account, confirmation }) {
      const m = await material(policy);
      try {
        await checkedProposalAccount(policy, p, account);
        const message = bytesToHex(H.hederaSharedMessage(policy, p));
        consume(m.id, message, confirmation);
        let consent: H.HederaConsent = {
          from: m.info.partyIndex,
          nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        };
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial(),
            existing = state.records[p.id];
          if (
            Object.values(state.records).some(
              (record) => record.plan.transactionId === p.transactionId && record.plan.id !== p.id,
            )
          )
            throw new Error('This transaction ID already belongs to another proposal');
          if (existing) {
            if (existing.message !== message || !existing.consent || existing.status !== 'pending')
              throw new Error('Proposal identifier was already used differently');
            consent = existing.consent;
            return state;
          }
          if (
            (p.kind === 'transfer' || p.approvalPolicyId === p.policyId) &&
            available(state, account) < BigInt(p.amount) + BigInt(p.maxFee)
          )
            throw new Error('Balance is insufficient after reserving other pending payments');
          return {
            ...state,
            records: { ...state.records, [p.id]: { plan: p, proposal: p, message, consent, status: 'pending' } },
          };
        });
        return consent;
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedRound({ policy, proposal: p, consents, round, inputs }) {
      const local = await approved(policy, p),
        m = await material(policy),
        sid = bytesToHex(H.hederaJointSid(policy, p, consents)),
        key = `${scope(m.id)}|${p.id}|${sid}`;
      if (
        !p.active.includes(m.info.partyIndex) ||
        consents.find((c) => c.from === m.info.partyIndex)?.nonce !== local.record.consent!.nonce
      ) {
        wipeKey(m.key);
        throw new Error('Signer consent randomness mismatch');
      }
      try {
        const cached = await kv.get<H.HederaRound>(`round|${key}|${round}`);
        if (cached) {
          wipeKey(m.key);
          return cached;
        }
        if (round === 1) {
          if (states.size >= 8) throw new Error('Too many active Hedera signing sessions');
          await deps.burn(sid);
          const output = m.party.round1({
            sid: fromHexLocal(sid),
            act: p.active,
            derivationIndex: policy.derivationIndex,
            msg: fromHexLocal(local.message),
          });
          states.set(key, {
            party: m.party,
            key: m.key,
            message: local.message,
            sid,
            expiresAt: p.expiresAt,
            stage: 1,
          });
          const result = { from: m.info.partyIndex, payload: H.hederaWireText(encodeRound1(output)) };
          await kv.set(`round|${key}|1`, result);
          return result;
        }
        wipeKey(m.key);
        const state = states.get(key);
        if (!state || state.message !== local.message || state.stage !== round - 1)
          throw new Error('Hedera round state was lost; prepare a fresh proposal');
        const values = p.active.map((from) => {
          const found = inputs.filter((input) => input.from === from);
          if (found.length !== 1) throw new Error('Incomplete Raccoon round');
          return H.hederaWireBytes(found[0]!.payload);
        });
        if (round === 2) {
          const result = {
            from: m.info.partyIndex,
            payload: H.hederaWireText(
              encodeRound2(
                state.party.round2(
                  fromHexLocal(sid),
                  values.map((v, i) => decodeRound1(p.active[i]!, v)),
                ),
                p.active,
              ),
            ),
          };
          state.stage = 2;
          await kv.set(`round|${key}|2`, result);
          return result;
        }
        const result = {
          from: m.info.partyIndex,
          payload: H.hederaWireText(
            encodeRound3(
              state.party.round3(
                fromHexLocal(sid),
                values.map((v, i) => decodeRound2(p.active[i]!, v, p.active)),
              ),
            ),
          ),
        };
        states.delete(key);
        wipeKey(state.key);
        await kv.set(`round|${key}|3`, result);
        return result;
      } catch (error) {
        const state = states.get(key);
        if (state) {
          wipeKey(state.key);
          states.delete(key);
        }
        wipeKey(m.key);
        throw error;
      }
    },
    async hSharedNative({ policy, proposal: p, approval, account }) {
      await approved(policy, p);
      const m = await material(policy);
      try {
        await checkedProposalAccount(policy, p, account);
        H.verifyHederaApproval(policy, p, approval);
        let partial: H.HederaPartial | undefined;
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial(),
            record = state.records[p.id];
          if (!record) throw new Error('Missing payment reservation');
          if (record.partial) {
            partial = record.partial;
            return state;
          }
          if (
            (p.kind === 'transfer' || p.approvalPolicyId === p.policyId) &&
            available(state, account, p.id) < BigInt(p.amount) + BigInt(p.maxFee)
          )
            throw new Error('Current balance cannot cover the reserved payment');
          partial = deps
            .unlocked()
            .keyring.withHederaSharedPrivateKey(policy.context, (key) =>
              H.signHederaNative(policy, p, approval, m.info.partyIndex, key),
            );
          return { ...state, records: { ...state.records, [p.id]: { ...record, partial, approval } } };
        });
        return partial!;
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedFinalize({ policy, proposal: p, approval, partials }) {
      await approved(policy, p);
      const m = await material(policy);
      try {
        const result = H.finalizeHederaShared(policy, p, approval, partials);
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial(),
            record = state.records[p.id];
          if (!record) throw new Error('Missing payment review');
          return { ...state, records: { ...state.records, [p.id]: { ...record, raw: result.raw, approval } } };
        });
        return result;
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedFinalizeRotation({
      policy,
      source,
      sourceApproval,
      sourcePartials,
      target,
      targetApproval,
      targetPartials,
    }) {
      const own = H.hederaPolicyId(policy) === H.hederaPolicyId(source.sourcePolicy!) ? source : target;
      await approved(policy, own);
      const m = await material(policy);
      try {
        const result = H.finalizeHederaKeyUpdate(
          source,
          sourceApproval,
          sourcePartials,
          target,
          targetApproval,
          targetPartials,
        );
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial(),
            record = state.records[own.id];
          if (!record) throw new Error('Missing rotation review');
          return {
            ...state,
            records: {
              ...state.records,
              [own.id]: {
                ...record,
                raw: result.raw,
                approval: own === source ? sourceApproval : targetApproval,
                rotation: { source, sourceApproval, target, targetApproval },
              },
            },
          };
        });
        return result;
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedCreate({ policy, plan, payerIndex, payer, confirmation }) {
      const m = await material(policy);
      try {
        H.verifyHederaSnapshotFresh(payer);
        const message = H.hederaPlanMessage(policy, plan);
        consume(m.id, message, confirmation);
        if (
          plan.kind !== 'create' ||
          payer.accountId !== plan.from ||
          payer.network !== 'testnet' ||
          payer.deleted ||
          payer.key.type !== 'ECDSA_SECP256K1' ||
          payer.key.key.toLowerCase() !== deps.unlocked().keyring.hederaPublicKey(payerIndex) ||
          BigInt(payer.tinybars) < BigInt(plan.maxFee)
        )
          throw new Error('Creation payer is not the funded personal wallet account');
        let raw = '';
        await kv.update<HederaState>(stateKey(m.id), (previous) => {
          const state = previous ?? initial(),
            pending = Object.values(state.records).find((r) => r.plan.kind === 'create' && r.status === 'pending');
          if (
            state.accountId ||
            Object.values(state.records).some((r) => r.plan.kind === 'create' && r.status === 'confirmed') ||
            (pending && pending.plan.id !== plan.id)
          )
            throw new Error('Check the saved account creation result before creating another account');
          const old = state.records[plan.id];
          if (old?.raw) {
            if (old.message !== message) throw new Error('Creation review changed');
            raw = old.raw;
            return state;
          }
          raw = deps
            .unlocked()
            .keyring.withHederaPrivateKey(payerIndex, (key) => H.signHederaCreation(policy, plan, key)).raw;
          return {
            ...state,
            records: { ...state.records, [plan.id]: { plan, message, raw, payerIndex, status: 'pending' } },
          };
        });
        return {
          raw,
          transactionId: plan.transactionId,
          expiresAt: plan.expiresAt,
          intentMemo: H.hederaNativeIntent(plan),
        };
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedReconcile({ policy, id, account, receipt }) {
      const m = await material(policy);
      try {
        const state = await load(m.id),
          record = state.records[id];
        if (!record || receipt.transactionId !== record.plan.transactionId)
          throw new Error('Receipt does not match the saved transaction');
        if (record.plan.kind === 'keyUpdate') {
          const expected =
            receipt.found && receipt.result === 'SUCCESS' && receipt.intentMemo === H.hederaNativeIntent(record.plan)
              ? record.plan.targetPolicy!
              : record.plan.sourcePolicy!;
          H.verifyHederaAccount(expected, account, record.plan.from);
          H.verifyHederaSnapshotFresh(account);
        } else if (record.plan.kind === 'transfer') await checkedAccount(policy, account, record.plan.from);
        else {
          if (account.accountId !== record.plan.from || account.network !== 'testnet')
            throw new Error('Wrong payer balance');
          H.verifyHederaSnapshotFresh(account);
        }
        let status: HederaRecord['status'] = 'pending';
        if (
          receipt.found &&
          receipt.result &&
          receipt.timestamp &&
          snapshotTime(account.balanceTimestamp) >= snapshotTime(receipt.timestamp)
        )
          status =
            receipt.result === 'SUCCESS' && receipt.intentMemo === H.hederaNativeIntent(record.plan)
              ? 'confirmed'
              : 'failed';
        else if (
          !receipt.found &&
          snapshotTime(account.balanceTimestamp) > BigInt(record.plan.expiresAt + 60000) * 1000000n
        )
          status = 'expired';
        return kv.update<HederaState>(stateKey(m.id), (current) => {
          if (!current?.records[id]) throw new Error('Missing saved transaction');
          return {
            ...current,
            records: {
              ...current.records,
              [id]: {
                ...current.records[id]!,
                status,
                ...(status === 'confirmed' && record.plan.kind === 'create' && receipt.entityId
                  ? { createdAccountId: H.hederaAccountId(receipt.entityId) }
                  : {}),
              },
            },
          };
        });
      } finally {
        wipeKey(m.key);
      }
    },
    async hSharedExport({ policy }) {
      const m = await material(policy);
      let bytes: Uint8Array | undefined, plain: Uint8Array | undefined;
      try {
        bytes = await deps.store.shareBytes(`hedera:${m.id}`);
        plain = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            policy,
            info: m.info,
            share: H.hederaWireText(bytes),
            state: await load(m.id),
            sids: await deps.usedSids(),
          }),
        );
        return await deps.store.sealHederaBackup(m.id, plain);
      } finally {
        wipeKey(m.key);
        if (bytes) wipe(bytes);
        if (plain) wipe(plain);
      }
    },
    async hSharedImport({ backup, password }) {
      deps.unlocked();
      deps.requireShares();
      deps.touch();
      const plain = await deps.store.openHederaBackup(backup, password);
      let key: KeyShare | undefined, bytes: Uint8Array | undefined;
      try {
        const data = JSON.parse(new TextDecoder().decode(plain)) as {
          version: number;
          policy: H.HederaSharedPolicy;
          info: ShareInfo;
          share: string;
          state: HederaState;
          sids: string[];
        };
        const id = H.hederaPolicyId(data.policy),
          member = data.policy.members.find((m) => m.partyIndex === data.info.partyIndex);
        if (
          data.version !== 1 ||
          id !== backup.policyId ||
          member?.participantId !== data.info.participantId ||
          member.publicKey !== deps.unlocked().keyring.hederaSharedPublicKey(data.policy.context) ||
          data.info.keygenId !== data.policy.context.keygenId ||
          data.info.membershipVersion !== data.policy.context.membershipVersion ||
          data.info.walletId !== data.policy.context.walletId ||
          data.info.threshold !== data.policy.raccoonThreshold ||
          data.info.parties !== data.policy.members.length ||
          data.state?.version !== 1 ||
          !data.state.records ||
          !Array.isArray(data.sids) ||
          data.sids.length > 100000 ||
          data.sids.some((sid) => typeof sid !== 'string' || !/^[0-9a-f]{64}$/.test(sid))
        )
          throw new Error('Recovery backup belongs to another native wallet or policy');
        bytes = H.hederaWireBytes(data.share);
        key = decodeKeyShare(bytes);
        if (
          key.index !== data.info.partyIndex ||
          H.hederaWireText(encodePublicKey(new QdParty(key).publicKey(data.policy.derivationIndex))) !==
            data.policy.raccoonPublicKey
        )
          throw new Error('Recovery share does not match this policy');
        if (
          data.state.version !== 1 ||
          !data.state.records ||
          data.sids.length > 100000 ||
          data.sids.some((s) => !/^[0-9a-f]{64}$/.test(s))
        )
          throw new Error('Invalid recovery metadata');
        if (data.state.accountId) H.hederaAccountId(data.state.accountId);
        // Merge nonce history before making a recovered share usable. Secret round
        // state and old consents are never restored: new Raccoon work needs fresh
        // per-signer randomness, including after a stale backup is imported.
        for (const [recordId, record] of Object.entries(data.state.records)) {
          if (
            recordId !== record.plan.id ||
            (record.plan.kind !== 'keyUpdate' && record.plan.policyId !== id) ||
            !['pending', 'confirmed', 'failed', 'expired'].includes(record.status)
          )
            throw new Error('Invalid recovered transaction');
          const auditTime = Math.min(Date.now(), record.plan.expiresAt - 1);
          H.validateHederaPlan(data.policy, record.plan, auditTime);
          if (record.plan.kind === 'create') {
            if (record.message !== H.hederaPlanMessage(data.policy, record.plan, auditTime))
              throw new Error('Recovered creation review changed');
          } else if (
            !record.proposal ||
            H.hederaPlanMessage(data.policy, record.proposal, auditTime) !==
              H.hederaPlanMessage(data.policy, record.plan, auditTime) ||
            record.message !== bytesToHex(H.hederaSharedMessage(data.policy, record.proposal, auditTime))
          )
            throw new Error('Recovered native payment and Raccoon authorization differ');
          if (record.plan.kind !== 'create' && (record.partial || record.raw)) {
            if (!record.proposal || !record.approval) throw new Error('Missing recovered Raccoon authorization');
            H.verifyHederaApproval(data.policy, record.proposal, record.approval, auditTime);
            if (record.partial) H.verifyHederaPartial(data.policy, record.plan, record.partial);
          }
          if (record.raw && record.plan.kind === 'keyUpdate') {
            if (!record.rotation) throw new Error('Missing dual-policy Raccoon authorization');
            if (
              bytesToHex(H.hederaBody(record.rotation.source)) !== bytesToHex(H.hederaBody(record.plan)) ||
              bytesToHex(H.hederaBody(record.rotation.target)) !== bytesToHex(H.hederaBody(record.plan))
            )
              throw new Error('Recovered rotation differs from its native signatures');
            H.verifyHederaApproval(
              record.plan.sourcePolicy!,
              record.rotation.source,
              record.rotation.sourceApproval,
              auditTime,
            );
            H.verifyHederaApproval(
              record.plan.targetPolicy!,
              record.rotation.target,
              record.rotation.targetApproval,
              auditTime,
            );
          }
          if (record.raw)
            H.verifyHederaSavedPlan(
              data.policy,
              record.plan,
              record.raw,
              record.plan.kind === 'create' ? deps.unlocked().keyring.hederaPublicKey(record.payerIndex!) : undefined,
            );
        }
        await deps.mergeSids(data.sids);
        await deps.store.putHederaArchive(id, data.info, bytes);
        await kv.set(policyKey(id), data.policy);
        await kv.update<HederaState>(stateKey(id), (previous) => {
          const records = { ...data.state.records, ...previous?.records };
          for (const [recordId, record] of Object.entries(records)) {
            if (recordId !== record.plan.id || (record.plan.kind !== 'keyUpdate' && record.plan.policyId !== id))
              throw new Error('Invalid recovered transaction');
            if (!previous?.records[recordId]) records[recordId] = { ...record, consent: undefined, status: 'pending' };
          }
          return { version: 1, accountId: previous?.accountId ?? data.state.accountId, records };
        });
        return { policy: data.policy, ...(data.state.accountId ? { accountId: data.state.accountId } : {}) };
      } finally {
        wipe(plain);
        if (bytes) wipe(bytes);
        if (key) wipeKey(key);
      }
    },
  };
  return {
    handlers,
    lock() {
      for (const state of states.values()) wipeKey(state.key);
      states.clear();
    },
  };
}
function fromHexLocal(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
}
