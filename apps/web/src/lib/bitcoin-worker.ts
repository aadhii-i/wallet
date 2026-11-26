/** Native Bitcoin shared custody. Private material stays in this worker module. */
import {
  type HDKeyring,
  type ConfirmationRegistry,
  type QdShareStore,
  type ShareInfo,
  bytesToHex,
  wipe,
} from '@qd/wallet-core';
import {
  bitcoinPolicyId,
  bitcoinWireText,
  bitcoinWireBytes,
  signBitcoinEnrollment,
  sharedBitcoinMessage,
  signSharedBitcoin,
  finalizeSharedBitcoin,
  verifyBitcoinApproval,
  psbtOutpoints,
  bitcoinSigningSid,
  validateSharedBitcoinProposal,
  verifySavedBitcoinPartial,
  verifySavedBitcoinTransaction,
  type BitcoinConsent,
  type BitcoinApproval,
  type BitcoinSharedPolicy,
  type SharedBitcoinProposal,
} from '@qd/bitcoin';
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
import { ledgerState, recordDiscovery, reserveBitcoin, type BitcoinLedger } from './bitcoin-ledger';
import type { VaultOps } from './vault-protocol';

export interface BitcoinSharedRecord {
  proposal: SharedBitcoinProposal;
  message: string;
  consent?: BitcoinConsent;
  approval?: BitcoinApproval;
  partial?: string;
  final?: { txid: string; raw: string; vsize: number };
  status: 'pending' | 'submitted' | 'confirmed';
}
export interface BitcoinSharedState extends BitcoinLedger {
  records?: Record<string, BitcoinSharedRecord>;
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
type Names = Extract<keyof VaultOps, `btcShared${string}`>;
type Handlers = { [K in Names]: (args: VaultOps[K]['req']) => Promise<VaultOps[K]['res']> };
const fromHexBytes = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
export function createBitcoinWorker(deps: Deps) {
  const btcKv = deps.kv ?? openKv('qd-bitcoin');
  const bitcoinParties = new Map<
    string,
    { party: QdParty; key: KeyShare; message: string; expiresAt: number; stage: 1 | 2 }
  >();
  function clearBitcoinKey(key: KeyShare): void {
    key.share.forEach((p) => p.fill(0));
    key.seedsOut.forEach((s) => s.fill(0));
    key.seedsIn.forEach((s) => s.fill(0));
    key.chaincode.fill(0);
  }
  function bitcoinPolicyKey(id: string): string {
    return `bitcoin-policy|${deps.unlocked().keyring.evmAddress(0)}|${id}`;
  }
  function bitcoinSharedLedger(id: string): string {
    return `bitcoin-shared-ledger|${deps.unlocked().keyring.evmAddress(0)}|${id}`;
  }
  async function bitcoinMaterial(policy: BitcoinSharedPolicy, pinned = true) {
    deps.requireShares();
    deps.touch();
    for (const [id, state] of bitcoinParties) {
      if (state.expiresAt <= Date.now()) {
        clearBitcoinKey(state.key);
        bitcoinParties.delete(id);
      }
    }
    const { keyring } = deps.unlocked(),
      id = bitcoinPolicyId(policy);
    if (pinned && !(await btcKv.get(bitcoinPolicyKey(id))))
      throw new Error('Compare and confirm the Bitcoin policy safety number first');
    const slot = pinned ? `bitcoin:${id}` : policy.context.walletId;
    const info = await deps.store.shareInfo(slot);
    if (
      !info ||
      info.keygenId !== policy.context.keygenId ||
      info.membershipVersion !== policy.context.membershipVersion ||
      info.threshold !== policy.raccoonThreshold ||
      info.parties !== policy.members.length
    )
      throw new Error('This Bitcoin policy does not match the local Raccoon share');
    const member = policy.members.find((m) => m.partyIndex === info.partyIndex);
    if (!member || member.participantId !== info.participantId || member.xpub !== keyring.btcSharedRoot(policy.context))
      throw new Error('This device is not an enrolled native signer');
    const bytes = await deps.store.shareBytes(slot);
    let key: KeyShare;
    try {
      key = decodeKeyShare(bytes);
    } finally {
      wipe(bytes);
    }
    const party = new QdParty(key);
    if (
      key.index !== info.partyIndex ||
      bitcoinWireText(encodePublicKey(party.publicKey(policy.derivationIndex))) !== policy.raccoonPublicKey
    ) {
      clearBitcoinKey(key);
      throw new Error('Bitcoin Raccoon public key mismatch');
    }
    return { id, info, party, key, member };
  }
  async function requireBitcoinApproval(policy: BitcoinSharedPolicy, proposal: SharedBitcoinProposal): Promise<string> {
    const message = Array.from(sharedBitcoinMessage(policy, proposal), (b) => b.toString(16).padStart(2, '0')).join('');
    const saved = (await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(proposal.policyId)))?.records?.[proposal.id];
    if (saved?.message !== message || !saved.consent)
      throw new Error('Review and approve this Bitcoin proposal on this device');
    return message;
  }

  const handlers: Handlers = {
    async btcSharedEnroll({ context, participantId, derivationIndex }) {
      const { keyring } = deps.unlocked();
      deps.requireShares();
      deps.touch();
      const info = await deps.store.shareInfo(context.walletId);
      if (
        !info ||
        info.keygenId !== context.keygenId ||
        info.membershipVersion !== context.membershipVersion ||
        info.participantId !== participantId ||
        context.network !== 'testnet4'
      )
        throw new Error('Shared Bitcoin enrollment context mismatch');
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
          xpub: keyring.btcSharedRoot(context),
          raccoonPublicKey: bitcoinWireText(encodePublicKey(new QdParty(key).publicKey(derivationIndex))),
        };
        return keyring.withBtcSharedPrivateKey(context, 0, 0, (privateKey) => signBitcoinEnrollment(entry, privateKey));
      } finally {
        clearBitcoinKey(key);
      }
    },
    async btcSharedPin({ policy, confirmation }) {
      const material = await bitcoinMaterial(policy, false);
      try {
        deps.unlocked().confirmations.consume(confirmation, {
          kind: 'bitcoin-shared',
          policyId: material.id,
          message: material.id,
        });
        await deps.store.archiveBitcoinShare(material.id, policy.context.walletId);
        await btcKv.set(bitcoinPolicyKey(material.id), policy);
        return { policyId: material.id };
      } finally {
        clearBitcoinKey(material.key);
      }
    },
    async btcSharedPlan({ policy, highestUsed }) {
      const material = await bitcoinMaterial(policy);
      try {
        const key = bitcoinSharedLedger(material.id);
        const state =
          highestUsed === undefined
            ? ledgerState(await btcKv.get<BitcoinLedger>(key))
            : await btcKv.update<BitcoinLedger>(key, (value) => recordDiscovery(value, highestUsed));
        return { next: state.next, unavailable: Object.keys(state.reservations) };
      } finally {
        clearBitcoinKey(material.key);
      }
    },
    async btcSharedApprove({ policy, proposal, confirmation }) {
      const material = await bitcoinMaterial(policy);
      try {
        const message = Array.from(sharedBitcoinMessage(policy, proposal), (b) => b.toString(16).padStart(2, '0')).join(
          '',
        );
        deps.unlocked().confirmations.consume(confirmation, { kind: 'bitcoin-shared', policyId: material.id, message });
        if (proposal.version !== 2)
          throw new Error('Create a fresh Bitcoin proposal to use the current signing protocol');
        let consent: BitcoinConsent = {
          from: material.info.partyIndex,
          nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        };
        await btcKv.update<BitcoinSharedState>(bitcoinSharedLedger(material.id), (previous) => {
          const state = ledgerState(previous) as BitcoinSharedState,
            old = state.records?.[proposal.id];
          if (old) {
            if (old.message !== message) throw new Error('Proposal identifier already used; create a fresh proposal');
            if (old.consent) {
              consent = old.consent;
              return state;
            }
            if (old.partial || old.final) throw new Error('Use saved-payment recovery for an already signed proposal');
            return { ...state, records: { ...state.records, [proposal.id]: { ...old, consent, status: 'pending' } } };
          }
          if (Object.keys(state.records ?? {}).length >= 1000)
            throw new Error('Bitcoin payment storage capacity reached; export recovery data');
          return {
            ...state,
            records: { ...state.records, [proposal.id]: { proposal, message, consent, status: 'pending' } },
          };
        });
        return { message, ...consent };
      } finally {
        clearBitcoinKey(material.key);
      }
    },
    async btcSharedRound({ policy, proposal, consents, round, inputs }) {
      const message = await requireBitcoinApproval(policy, proposal),
        consent = (await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(proposal.policyId)))?.records?.[proposal.id]
          ?.consent,
        sid = bytesToHex(bitcoinSigningSid(policy, proposal, consents)),
        stateKey = `${bitcoinPolicyKey(proposal.policyId)}|${proposal.id}|${sid}`;
      if (proposal.version !== 2 || !consent || consents.find((c) => c.from === consent.from)?.nonce !== consent.nonce)
        throw new Error('Bitcoin signer consent randomness mismatch');
      const cached = await btcKv.get<{ from: number; payload: string }>(`bitcoin-round|${stateKey}|${round}`);
      if (cached) return cached;
      const material = await bitcoinMaterial(policy);
      const index = material.info.partyIndex;
      if (!proposal.active.includes(index)) {
        clearBitcoinKey(material.key);
        throw new Error('This device is not a selected Raccoon signer');
      }
      try {
        if (round === 1) {
          if (bitcoinParties.size >= 8) throw new Error('Too many active Bitcoin signing sessions');
          await deps.burn(sid);
          const output = material.party.round1({
            sid: fromHexBytes(sid),
            act: proposal.active,
            derivationIndex: policy.derivationIndex,
            msg: fromHexBytes(message),
          });
          bitcoinParties.set(stateKey, {
            party: material.party,
            key: material.key,
            message,
            expiresAt: proposal.expiresAt,
            stage: 1,
          });
          const result = { from: index, payload: bitcoinWireText(encodeRound1(output)) };
          await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
          return result;
        }
        clearBitcoinKey(material.key);
        const state = bitcoinParties.get(stateKey);
        if (!state || state.message !== message || state.stage !== round - 1)
          throw new Error('Bitcoin signing state was lost; start a fresh proposal');
        const ordered = proposal.active.map((from) => {
          const found = inputs.filter((input) => input.from === from);
          if (found.length !== 1) throw new Error('Incomplete Raccoon round');
          return bitcoinWireBytes(found[0]!.payload);
        });
        if (round === 2) {
          const output = state.party.round2(
            fromHexBytes(sid),
            ordered.map((b, i) => decodeRound1(proposal.active[i]!, b)),
          );
          state.stage = 2;
          const result = { from: index, payload: bitcoinWireText(encodeRound2(output, proposal.active)) };
          await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
          return result;
        }
        const output = state.party.round3(
          fromHexBytes(sid),
          ordered.map((b, i) => decodeRound2(proposal.active[i]!, b, proposal.active)),
        );
        const result = { from: index, payload: bitcoinWireText(encodeRound3(output)) };
        bitcoinParties.delete(stateKey);
        clearBitcoinKey(state.key);
        await btcKv.set(`bitcoin-round|${stateKey}|${round}`, result);
        return result;
      } catch (error) {
        const state = bitcoinParties.get(stateKey);
        if (state) {
          clearBitcoinKey(state.key);
          bitcoinParties.delete(stateKey);
        }
        clearBitcoinKey(material.key);
        throw error;
      }
    },
    async btcSharedNativeSign({ policy, proposal, approval }) {
      await requireBitcoinApproval(policy, proposal);
      const material = await bitcoinMaterial(policy);
      try {
        verifyBitcoinApproval(policy, proposal, approval);
        const previous = (await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(material.id)))?.records?.[proposal.id]
          ?.partial;
        if (previous) return { partial: previous, from: material.info.partyIndex };
        let partial = '';
        const points = psbtOutpoints(proposal.psbt),
          ledgerKey = bitcoinSharedLedger(material.id);
        await btcKv.update<BitcoinSharedState>(ledgerKey, (value) => {
          const previous = ledgerState(value) as BitcoinSharedState;
          if (previous.records?.[proposal.id]?.partial) {
            partial = previous.records[proposal.id]!.partial!;
            return previous;
          }
          const state = reserveBitcoin(
            previous,
            proposal.id,
            points,
            proposal.changeIndex ?? undefined,
            !!proposal.migration,
          ) as BitcoinSharedState;
          const record = state.records?.[proposal.id];
          if (!record?.consent) throw new Error('Missing local Bitcoin approval');
          partial = signSharedBitcoin(policy, proposal, approval, material.info.partyIndex, (branch, index, fn) =>
            deps.unlocked().keyring.withBtcSharedPrivateKey(policy.context, branch, index, fn),
          );
          return {
            ...state,
            signed: { ...state.signed, [proposal.id]: { txid: proposal.id, raw: partial, createdAt: Date.now() } },
            records: { ...state.records, [proposal.id]: { ...record, partial, approval } },
          };
        });
        return { partial, from: material.info.partyIndex };
      } finally {
        clearBitcoinKey(material.key);
      }
    },
    async btcSharedFinalize({ policy, proposal, approval, partials }) {
      const material = await bitcoinMaterial(policy);
      try {
        await requireBitcoinApproval(policy, proposal);
        const finalized = finalizeSharedBitcoin(policy, proposal, approval, partials);
        await btcKv.update<BitcoinSharedState>(bitcoinSharedLedger(material.id), (previous) => {
          let state = ledgerState(previous) as BitcoinSharedState;
          const record = state.records?.[proposal.id],
            points = psbtOutpoints(proposal.psbt);
          if (!record?.consent) throw new Error('Missing local Bitcoin approval');
          if (!points.every((point) => state.reservations[point] === proposal.id))
            state = reserveBitcoin(
              state,
              proposal.id,
              points,
              proposal.changeIndex ?? undefined,
              !!proposal.migration,
            ) as BitcoinSharedState;
          return { ...state, records: { ...state.records, [proposal.id]: { ...record, final: finalized, approval } } };
        });
        return finalized;
      } finally {
        clearBitcoinKey(material.key);
      }
    },
    async btcSharedStatus({ policy }) {
      const m = await bitcoinMaterial(policy);
      try {
        return ledgerState(await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(m.id))) as BitcoinSharedState;
      } finally {
        clearBitcoinKey(m.key);
      }
    },
    async btcSharedSaved({ policy, id }) {
      const m = await bitcoinMaterial(policy);
      try {
        const record = (await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(m.id)))?.records?.[id];
        if (!record) throw new Error('Saved Bitcoin payment not found');
        const auditTime = Math.min(Date.now(), record.proposal.expiresAt - 1);
        validateSharedBitcoinProposal(policy, record.proposal, auditTime);
        if (record.final) {
          if (!record.approval) throw new Error('Missing saved Raccoon authorization');
          verifyBitcoinApproval(policy, record.proposal, record.approval, auditTime);
          const final = verifySavedBitcoinTransaction(policy, record.proposal, record.final.raw);
          if (final.txid !== record.final.txid) throw new Error('Saved Bitcoin transaction ID mismatch');
          return { proposal: record.proposal, final };
        }
        return { proposal: record.proposal };
      } finally {
        clearBitcoinKey(m.key);
      }
    },
    async btcSharedReconcile({ policy, id, txid, status }) {
      const m = await bitcoinMaterial(policy);
      try {
        if (!['pending', 'confirmed'].includes(status)) throw new Error('Invalid Bitcoin transaction status');
        await btcKv.update<BitcoinSharedState>(bitcoinSharedLedger(m.id), (previous) => {
          const state = ledgerState(previous) as BitcoinSharedState,
            record = state.records?.[id];
          if (!record?.final || record.final.txid !== txid) throw new Error('Result does not match the saved payment');
          // Never release signed inputs or rewind change: an old signature can
          // remain usable after local expiry or a Bitcoin reorganization.
          return {
            ...state,
            records: {
              ...state.records,
              [id]: { ...record, status: status === 'confirmed' ? 'confirmed' : 'submitted' },
            },
          };
        });
      } finally {
        clearBitcoinKey(m.key);
      }
    },
    async btcSharedExport({ policy }) {
      const m = await bitcoinMaterial(policy);
      let bytes: Uint8Array | undefined, plain: Uint8Array | undefined;
      try {
        bytes = await deps.store.shareBytes(`bitcoin:${m.id}`);
        const state = ledgerState(await btcKv.get<BitcoinSharedState>(bitcoinSharedLedger(m.id))) as BitcoinSharedState;
        if (Object.keys(state.signed).some((id) => !state.records?.[id]?.partial))
          throw new Error('Finish legacy signed proposals on this device before exporting a complete recovery backup');
        plain = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            policy,
            info: m.info,
            share: bitcoinWireText(bytes),
            state,
            sids: await deps.usedSids(),
          }),
        );
        return await deps.store.sealBitcoinBackup(m.id, plain);
      } finally {
        clearBitcoinKey(m.key);
        if (bytes) wipe(bytes);
        if (plain) wipe(plain);
      }
    },
    async btcSharedImport({ backup, password }) {
      deps.unlocked();
      deps.requireShares();
      deps.touch();
      const plain = await deps.store.openBitcoinBackup(backup, password);
      let bytes: Uint8Array | undefined, key: KeyShare | undefined;
      try {
        const data = JSON.parse(new TextDecoder().decode(plain)) as {
          version: number;
          policy: BitcoinSharedPolicy;
          info: ShareInfo;
          share: string;
          state: BitcoinSharedState;
          sids: string[];
        };
        const id = bitcoinPolicyId(data.policy),
          member = data.policy.members.find((m) => m.partyIndex === data.info.partyIndex);
        if (
          data.version !== 1 ||
          id !== backup.policyId ||
          !member ||
          member.participantId !== data.info.participantId ||
          member.xpub !== deps.unlocked().keyring.btcSharedRoot(data.policy.context) ||
          data.info.walletId !== data.policy.context.walletId ||
          data.info.keygenId !== data.policy.context.keygenId ||
          data.info.membershipVersion !== data.policy.context.membershipVersion ||
          data.info.threshold !== data.policy.raccoonThreshold ||
          data.info.parties !== data.policy.members.length ||
          !Array.isArray(data.sids) ||
          data.sids.length > 100000 ||
          data.sids.some((s) => typeof s !== 'string' || !/^[0-9a-f]{64}$/.test(s))
        )
          throw new Error('Recovery backup belongs to another native wallet or policy');
        bytes = bitcoinWireBytes(data.share);
        key = decodeKeyShare(bytes);
        if (
          key.index !== data.info.partyIndex ||
          bitcoinWireText(encodePublicKey(new QdParty(key).publicKey(data.policy.derivationIndex))) !==
            data.policy.raccoonPublicKey
        )
          throw new Error('Recovered Raccoon share does not match this Bitcoin policy');
        const state = ledgerState(data.state) as BitcoinSharedState;
        if (Object.keys(state.records ?? {}).length > 1000 || Object.keys(state.reservations).length > 100000)
          throw new Error('Bitcoin recovery metadata is oversized');
        for (const [recordId, r] of Object.entries(state.records ?? {})) {
          const auditTime = Math.min(Date.now(), r.proposal.expiresAt - 1);
          if (
            recordId !== r.proposal.id ||
            r.proposal.policyId !== id ||
            bytesToHex(sharedBitcoinMessage(data.policy, r.proposal, auditTime)) !== r.message
          )
            throw new Error('Invalid recovered Bitcoin payment');
          if (r.partial || r.final) {
            if (!r.approval) throw new Error('Missing recovered Raccoon authorization');
            verifyBitcoinApproval(data.policy, r.proposal, r.approval, auditTime);
            for (const point of psbtOutpoints(r.proposal.psbt))
              if (state.reservations[point] !== recordId) {
                const owner = state.records?.[state.reservations[point]!];
                if (
                  !r.proposal.migration ||
                  !owner ||
                  (!owner.partial && !owner.final) ||
                  !psbtOutpoints(owner.proposal.psbt).includes(point)
                )
                  throw new Error('Missing signed-input reservation');
              }
            if (r.proposal.changeIndex !== null && state.next <= r.proposal.changeIndex)
              throw new Error('Recovery would reuse a signed change address');
          }
          if (r.partial) verifySavedBitcoinPartial(data.policy, r.proposal, r.partial, data.info.partyIndex);
          if (r.final && verifySavedBitcoinTransaction(data.policy, r.proposal, r.final.raw).txid !== r.final.txid)
            throw new Error('Recovered Bitcoin transaction ID mismatch');
        }
        for (const [recordId, signed] of Object.entries(state.signed)) {
          const r = state.records?.[recordId];
          if (!r?.partial || signed.raw !== r.partial)
            throw new Error('Legacy signed metadata requires its original device and proposal');
        }
        for (const [point, owner] of Object.entries(state.reservations))
          if (!/^[0-9a-f]{64}:[0-9]{1,10}$/.test(point) || !state.records?.[owner])
            throw new Error('Invalid recovered coin reservation');
        // Validate everything before installing the share. Atomic cursor/reservation
        // merge is conservative across tabs. Import never revives an old consent.
        await deps.mergeSids(data.sids);
        await btcKv.update<BitcoinSharedState>(bitcoinSharedLedger(id), (previous) => {
          const current = ledgerState(previous) as BitcoinSharedState;
          for (const [point, owner] of Object.entries(state.reservations))
            if (current.reservations[point] && current.reservations[point] !== owner)
              throw new Error('Recovery conflicts with a local signed payment');
          const records: Record<string, BitcoinSharedRecord> = Object.fromEntries(
            Object.entries(state.records ?? {}).map(([key, record]) => [
              key,
              { ...record, consent: undefined, status: 'pending' },
            ]),
          );
          for (const [key, record] of Object.entries(current.records ?? {})) {
            if (records[key] && records[key]!.message !== record.message)
              throw new Error('Recovery proposal conflicts with local history');
            records[key] = record;
          }
          return {
            ...current,
            next: Math.max(current.next, state.next),
            highestUsed: Math.max(current.highestUsed, state.highestUsed),
            reservations: { ...state.reservations, ...current.reservations },
            signed: { ...state.signed, ...current.signed },
            records,
          };
        });
        await deps.store.putBitcoinArchive(id, data.info, bytes);
        await btcKv.set(bitcoinPolicyKey(id), data.policy);
        return { policy: data.policy };
      } finally {
        if (key) clearBitcoinKey(key);
        if (bytes) wipe(bytes);
        wipe(plain);
      }
    },
  };
  return {
    handlers,
    lock() {
      for (const state of bitcoinParties.values()) clearBitcoinKey(state.key);
      bitcoinParties.clear();
    },
  };
}
