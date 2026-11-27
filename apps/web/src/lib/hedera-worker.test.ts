import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmationRegistry, HDKeyring, QdShareStore, bytesToHex, type ShareInfo } from '@qd/wallet-core';
import { dealerKeyGen, encodeKeyShare, encodePublicKey, masterKeyFingerprint, QdParty } from '@qd/qd-crypto';
import * as H from '@qd/hedera';
import { createHederaWorker } from './hedera-worker';
import type { openKv } from './idb';

function memoryKv(): ReturnType<typeof openKv> {
  const data = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    clear: async () => {
      data.clear();
    },
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
      return key;
    },
    del: async (key: string) => {
      data.delete(key);
    },
    update<T>(key: string, fn: (value: T | undefined) => T): Promise<T> {
      const next = queue.then(() => {
        const result = fn(structuredClone(data.get(key)) as T | undefined);
        data.set(key, structuredClone(result));
        return structuredClone(result);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
const context = {
  walletId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  keygenId: '33333333-3333-4333-8333-333333333333',
  membershipVersion: 3,
  network: 'testnet' as const,
};
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Shared-test-password-42';
const shares = dealerKeyGen(2, 3).shares;
const opts = { kdf: { m: 256, t: 1, p: 1 }, allowWeakKdfForTests: true };
type Device = Awaited<ReturnType<typeof device>>;
const devices: Device[] = [];
let policy: H.HederaSharedPolicy;
async function device(
  index: number,
  withShare = true,
  group = context,
  groupShares = shares,
  prefix = '44444444-4444-4444-8444-44444444444',
) {
  const keys = await HDKeyring.fromMnemonic(phrase, `hedera-device-${index}`),
    confirmations = new ConfirmationRegistry(),
    kv = memoryKv(),
    store = new QdShareStore(memoryKv(), opts);
  await store.unlock(PW);
  if (withShare) {
    const share = groupShares[index]!,
      info: ShareInfo = {
        ...group,
        participantId: `${prefix}${index}`,
        partyIndex: index + 1,
        threshold: 2,
        parties: 3,
        fingerprint: bytesToHex(masterKeyFingerprint(share)),
        storedAt: new Date().toISOString(),
      };
    await store.putShare(info, encodeKeyShare(share));
  }
  const used: string[] = [];
  const worker = createHederaWorker({
    kv,
    unlocked: () => ({ keyring: keys, confirmations }),
    store,
    requireShares: () => {
      if (!store.unlocked) throw new Error('locked');
    },
    touch: () => {},
    burn: async (sid) => {
      if (used.includes(sid)) throw new Error('reused');
      used.push(sid);
    },
    usedSids: async () => [...used],
    mergeSids: async (sids) => {
      for (const sid of sids) if (!used.includes(sid)) used.push(sid);
    },
  });
  return { keys, confirmations, store, used, worker, ops: worker.handlers };
}
function confirmation(d: Device, message: string) {
  return d.confirmations.issue({ kind: 'hedera-shared', policyId: H.hederaPolicyId(policy), message });
}
function account(): H.HederaAccountInfo {
  return {
    network: 'testnet',
    accountId: '0.0.777',
    tinybars: '10000000000',
    balanceTimestamp: `${Math.floor(Date.now() / 1000)}.999999999`,
    deleted: false,
    receiverSignatureRequired: false,
    key: { type: 'ProtobufEncoded', key: H.hederaThresholdKeyHex(policy) },
  };
}
beforeAll(async () => {
  for (let i = 0; i < 3; i++) devices.push(await device(i));
  const entries = await Promise.all(
    devices.map((d, i) =>
      d.ops.hSharedEnroll({ context, participantId: `44444444-4444-4444-8444-44444444444${i}`, derivationIndex: 7 }),
    ),
  );
  policy = H.createHederaPolicy(entries);
  for (const d of devices) {
    await d.ops.hSharedPin({ policy, confirmation: confirmation(d, H.hederaPolicyId(policy)) });
    await d.ops.hSharedBind({ policy, account: account(), confirmation: confirmation(d, 'bind:0.0.777') });
  }
});
afterAll(() => {
  for (const d of devices) {
    d.worker.lock();
    d.keys.lock();
    d.store.lock();
  }
});
describe('Hedera worker security and recovery', () => {
  it('requires explicit payment consent and verifies the complete account policy', async () => {
    const d = devices[0]!,
      p = H.makeHederaProposal(policy, '0.0.777', '0.0.778', 40000000n, 1000000n, [1, 2]);
    await expect(d.ops.hSharedRound({ policy, proposal: p, consents: [], round: 1, inputs: [] })).rejects.toThrow(
      /approve/,
    );
    await expect(
      d.ops.hSharedApprove({
        policy,
        proposal: p,
        account: { ...account(), key: { type: 'ECDSA_SECP256K1', key: policy.members[0]!.publicKey } },
        confirmation: confirmation(d, bytesToHex(H.hederaSharedMessage(policy, p))),
      }),
    ).rejects.toThrow(/threshold/);
  });
  it('persists real native signatures and final bytes, then restores an encrypted share backup', async () => {
    let completed = false;
    for (let attempt = 0; attempt < 16 && !completed; attempt++) {
      const p = H.makeHederaProposal(policy, '0.0.777', '0.0.778', 40000000n, 1000000n, [1, 2]),
        message = bytesToHex(H.hederaSharedMessage(policy, p));
      const allConsents = await Promise.all(
          devices.map((d) =>
            d.ops.hSharedApprove({ policy, proposal: p, account: account(), confirmation: confirmation(d, message) }),
          ),
        ),
        consents = allConsents.filter((c) => p.active.includes(c.from));
      const r1 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.hSharedRound({ policy, proposal: p, consents, round: 1, inputs: [] })),
      );
      const r2 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.hSharedRound({ policy, proposal: p, consents, round: 2, inputs: r1 })),
      );
      const r3 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.hSharedRound({ policy, proposal: p, consents, round: 3, inputs: r2 })),
      );
      let approval: H.HederaApproval;
      try {
        approval = H.combineHederaApproval(policy, p, consents, r1, r2, r3);
      } catch (error) {
        if (attempt === 15) throw error;
        continue;
      }
      const partials = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.hSharedNative({ policy, proposal: p, approval, account: account() })),
      );
      const signed = await devices[0]!.ops.hSharedFinalize({ policy, proposal: p, approval, partials });
      expect((await devices[0]!.ops.hSharedStatus({ policy })).records[p.id]!.raw).toBe(signed.raw);
      const backup = await devices[0]!.ops.hSharedExport({ policy });
      expect(JSON.stringify(backup)).not.toContain(H.hederaWireText(encodeKeyShare(shares[0]!)));
      const decoded = await devices[0]!.store.openHederaBackup(backup, PW);
      const changed = JSON.parse(new TextDecoder().decode(decoded));
      decoded.fill(0);
      changed.state.records[p.id].plan.to = '0.0.779';
      const damaged = await devices[0]!.store.sealHederaBackup(
        backup.policyId,
        new TextEncoder().encode(JSON.stringify(changed)),
      );
      await expect(devices[0]!.ops.hSharedImport({ backup: damaged, password: PW })).rejects.toThrow();
      const fresh = await device(0, false);
      fresh.used.push('ab'.repeat(32));
      try {
        await fresh.ops.hSharedImport({ backup, password: PW });
        const restored = await fresh.ops.hSharedStatus({ policy });
        expect(restored.accountId).toBe('0.0.777');
        expect(restored.records[p.id]!.raw).toBe(signed.raw);
        expect(restored.records[p.id]!.consent).toBeUndefined();
        expect(fresh.used).toContain('ab'.repeat(32));
        expect(fresh.used).toContain(bytesToHex(H.hederaJointSid(policy, p, consents)));
        await expect(fresh.ops.hSharedRound({ policy, proposal: p, consents, round: 1, inputs: [] })).rejects.toThrow(
          /approve/,
        );
        const wrong = await device(2, false);
        try {
          await expect(wrong.ops.hSharedImport({ backup, password: PW })).rejects.toThrow(/another native wallet/);
        } finally {
          wrong.worker.lock();
          wrong.store.lock();
          wrong.keys.lock();
        }
        await expect(fresh.ops.hSharedImport({ backup, password: 'Wrong-password-42' })).rejects.toThrow();
      } finally {
        fresh.worker.lock();
        fresh.store.lock();
        fresh.keys.lock();
      }
      const spy = vi.spyOn(devices[2]!.keys, 'withHederaSharedPrivateKey');
      await expect(
        devices[2]!.ops.hSharedNative({
          policy,
          proposal: p,
          approval: { ...approval, signature: H.hederaWireText(new Uint8Array(64)) },
          account: account(),
        }),
      ).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      completed = true;
    }
    expect(completed).toBe(true);
  });
  it('refuses overspending across pending proposals', async () => {
    const d = devices[0]!,
      p = H.makeHederaProposal(policy, '0.0.777', '0.0.778', 10000000000n, 1000000n, [1, 2]);
    await expect(
      d.ops.hSharedApprove({
        policy,
        proposal: p,
        account: account(),
        confirmation: confirmation(d, bytesToHex(H.hederaSharedMessage(policy, p))),
      }),
    ).rejects.toThrow(/insufficient/);
  });
});

it('rotates only with both independent Raccoon and native quorums and recovers the exact signed update', async () => {
  const targetContext = {
    ...context,
    walletId: '55555555-5555-4555-8555-555555555555',
    accountId: '66666666-6666-4666-8666-666666666666',
    keygenId: '77777777-7777-4777-8777-777777777777',
  };
  const targetShares = dealerKeyGen(2, 3).shares,
    prefix = '88888888-8888-4888-8888-88888888888';
  const old: Device[] = [],
    next: Device[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      old.push(await device(i));
      next.push(await device(i, true, targetContext, targetShares, prefix));
    }
    const target = H.createHederaPolicy(
      await Promise.all(
        next.map((d, i) =>
          d.ops.hSharedEnroll({ context: targetContext, participantId: `${prefix}${i}`, derivationIndex: 7 }),
        ),
      ),
    );
    const token = (d: Device, p: H.HederaSharedPolicy, message: string) =>
      d.confirmations.issue({ kind: 'hedera-shared', policyId: H.hederaPolicyId(p), message });
    for (const d of old) {
      await d.ops.hSharedPin({ policy, confirmation: token(d, policy, H.hederaPolicyId(policy)) });
      await d.ops.hSharedBind({ policy, account: account(), confirmation: token(d, policy, 'bind:0.0.777') });
    }
    for (const d of next)
      await d.ops.hSharedPin({ policy: target, confirmation: token(d, target, H.hederaPolicyId(target)) });
    const evidence = async (pool: Device[], p: H.HederaSharedPolicy, proposal: H.HederaProposal) => {
      const message = bytesToHex(H.hederaSharedMessage(p, proposal));
      const consents = await Promise.all(
        pool
          .slice(0, 2)
          .map((d) =>
            d.ops.hSharedApprove({ policy: p, proposal, account: account(), confirmation: token(d, p, message) }),
          ),
      );
      const first = await Promise.all(
        pool.slice(0, 2).map((d) => d.ops.hSharedRound({ policy: p, proposal, consents, round: 1, inputs: [] })),
      );
      const second = await Promise.all(
        pool.slice(0, 2).map((d) => d.ops.hSharedRound({ policy: p, proposal, consents, round: 2, inputs: first })),
      );
      const third = await Promise.all(
        pool.slice(0, 2).map((d) => d.ops.hSharedRound({ policy: p, proposal, consents, round: 3, inputs: second })),
      );
      const approval = H.combineHederaApproval(p, proposal, consents, first, second, third);
      const partials = await Promise.all(
        pool.slice(0, 2).map((d) => d.ops.hSharedNative({ policy: p, proposal, approval, account: account() })),
      );
      return { approval, partials };
    };
    let completed = false;
    for (let attempt = 0; attempt < 16 && !completed; attempt++) {
      const plan = H.makeHederaKeyUpdate(policy, target, '0.0.777', crypto.randomUUID(), [1, 2], [1, 2], 1000000n);
      let a: Awaited<ReturnType<typeof evidence>>, b: Awaited<ReturnType<typeof evidence>>;
      try {
        a = await evidence(old, policy, plan.source);
        b = await evidence(next, target, plan.target);
      } catch (error) {
        if (attempt === 15) throw error;
        continue;
      }
      await expect(
        old[0]!.ops.hSharedFinalize({ policy, proposal: plan.source, approval: a.approval, partials: a.partials }),
      ).rejects.toThrow(/both|rotation/i);
      const req = {
        policy,
        source: plan.source,
        sourceApproval: a.approval,
        sourcePartials: a.partials,
        target: plan.target,
        targetApproval: b.approval,
        targetPartials: b.partials,
      };
      await expect(old[0]!.ops.hSharedFinalizeRotation({ ...req, targetPartials: [] })).rejects.toThrow();
      const signed = await old[0]!.ops.hSharedFinalizeRotation(req);
      const targetSigned = await next[0]!.ops.hSharedFinalizeRotation({ ...req, policy: target });
      expect(targetSigned.raw).toBe(signed.raw);
      const backup = await next[0]!.ops.hSharedExport({ policy: target }),
        restored = await device(0, false, targetContext, targetShares, prefix);
      try {
        await restored.ops.hSharedImport({ backup, password: PW });
        const state = await restored.ops.hSharedStatus({ policy: target });
        expect(state.records[plan.target.id]!.raw).toBe(signed.raw);
        expect(state.records[plan.target.id]!.consent).toBeUndefined();
        await restored.ops.hSharedReconcile({
          policy: target,
          id: plan.target.id,
          account: { ...account(), key: { type: 'ProtobufEncoded', key: H.hederaThresholdKeyHex(target) } },
          receipt: {
            found: true,
            transactionId: signed.transactionId,
            result: 'SUCCESS',
            intentMemo: signed.intentMemo,
            timestamp: `${Math.floor(Date.now() / 1000) - 1}.000000000`,
          },
        });
        expect((await restored.ops.hSharedStatus({ policy: target })).records[plan.target.id]!.status).toBe(
          'confirmed',
        );
      } finally {
        restored.worker.lock();
        restored.keys.lock();
        restored.store.lock();
      }
      completed = true;
    }
    expect(completed).toBe(true);
  } finally {
    for (const d of [...old, ...next]) {
      d.worker.lock();
      d.keys.lock();
      d.store.lock();
    }
  }
}, 60000);
