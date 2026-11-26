import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { ConfirmationRegistry, HDKeyring, QdShareStore, bytesToHex, type ShareInfo } from '@qd/wallet-core';
import { dealerKeyGen, encodeKeyShare, masterKeyFingerprint } from '@qd/qd-crypto';
import * as B from '@qd/bitcoin';
import { createBitcoinWorker } from './bitcoin-worker';
import type { openKv } from './idb';

function memoryKv(): ReturnType<typeof openKv> {
  const data = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    clear: async () => {
      data.clear();
    },
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    set: async (key, value) => {
      data.set(key, structuredClone(value));
      return key;
    },
    del: async (key) => {
      data.delete(key);
    },
    update<T>(key: string, fn: (value: T | undefined) => T): Promise<T> {
      const run = queue.then(() => {
        const result = fn(structuredClone(data.get(key)) as T | undefined);
        data.set(key, structuredClone(result));
        return structuredClone(result);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
const context = {
  walletId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  keygenId: '33333333-3333-4333-8333-333333333333',
  membershipVersion: 3,
  network: 'testnet4' as const,
};
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'Bitcoin-backup-test-only-42';
const dealt = dealerKeyGen(2, 3);
let policy: B.BitcoinSharedPolicy, coin: B.SharedBitcoinCoin;
const devices: Awaited<ReturnType<typeof device>>[] = [];
async function device(index: number, passphrase = `bitcoin-worker-${index}`) {
  const keys = await HDKeyring.fromMnemonic(phrase, passphrase),
    kv = memoryKv(),
    confirmations = new ConfirmationRegistry(),
    store = new QdShareStore(memoryKv(), { allowWeakKdfForTests: true, kdf: { m: 256, t: 1, p: 1 } }),
    used = new Set<string>();
  await store.unlock(PW);
  const info: ShareInfo = {
    walletId: context.walletId,
    keygenId: context.keygenId,
    membershipVersion: 3,
    participantId: `44444444-4444-4444-8444-44444444444${index}`,
    partyIndex: index + 1,
    threshold: 2,
    parties: 3,
    fingerprint: bytesToHex(masterKeyFingerprint(dealt.shares[index]!)),
    storedAt: new Date().toISOString(),
  };
  await store.putShare(info, encodeKeyShare(dealt.shares[index]!));
  const worker = createBitcoinWorker({
    kv,
    unlocked: () => ({ keyring: keys, confirmations }),
    store,
    requireShares: () => {
      if (!store.unlocked) throw new Error('locked');
    },
    touch: () => {},
    burn: async (sid) => {
      if (used.has(sid)) throw new Error('used');
      used.add(sid);
    },
    usedSids: async () => [...used],
    mergeSids: async (sids) => {
      sids.forEach((s) => used.add(s));
    },
  });
  return { keys, store, worker, ops: worker.handlers, confirmations, used, info };
}
const confirm = (d: (typeof devices)[number], message: string) =>
  d.confirmations.issue({ kind: 'bitcoin-shared', policyId: B.bitcoinPolicyId(policy), message });
const proposal = () =>
  B.makeSharedBitcoinProposal(
    policy,
    [coin],
    devices[0]!.keys.btcAddress(9, 'p2wpkh', 'testnet4'),
    40000n,
    2,
    0,
    [1, 2],
  );
beforeAll(async () => {
  for (let i = 0; i < 3; i++) devices.push(await device(i));
  policy = B.createBitcoinPolicy(
    await Promise.all(
      devices.map((d) => d.ops.btcSharedEnroll({ context, participantId: d.info.participantId, derivationIndex: 7 })),
    ),
  );
  for (const d of devices) await d.ops.btcSharedPin({ policy, confirmation: confirm(d, B.bitcoinPolicyId(policy)) });
  const output = B.sharedBitcoinOutput(policy, 0, 0),
    funding = new Transaction({ allowUnknownInputs: true });
  funding.addInput({ txid: '11'.repeat(32), index: 0 });
  funding.addOutput({ amount: 100000n, script: output.script });
  funding.updateInput(0, { finalScriptSig: new Uint8Array([0]) });
  coin = {
    txid: funding.id,
    vout: 0,
    value: 100000n,
    scriptPubKey: bytesToHex(output.script),
    confirmations: 6,
    branch: 0,
    addressIndex: 0,
    previousTx: bytesToHex(funding.toBytes(true, false)),
  };
});
afterAll(() => {
  for (const d of devices) {
    d.worker.lock();
    d.keys.lock();
    d.store.lock();
  }
});

describe('Bitcoin worker release hardening', () => {
  it('requires local consent and rejects coordinator substitutions of signer randomness', async () => {
    const p = proposal(),
      d = devices[0]!,
      message = bytesToHex(B.sharedBitcoinMessage(policy, p));
    await expect(d.ops.btcSharedRound({ policy, proposal: p, consents: [], round: 1, inputs: [] })).rejects.toThrow(
      /approve/,
    );
    const own = await d.ops.btcSharedApprove({ policy, proposal: p, confirmation: confirm(d, message) });
    await expect(
      d.ops.btcSharedRound({
        policy,
        proposal: p,
        consents: [
          { from: 1, nonce: '22'.repeat(32) },
          { from: 2, nonce: '33'.repeat(32) },
        ],
        round: 1,
        inputs: [],
      }),
    ).rejects.toThrow(/randomness/);
    const stale = await d.ops.btcSharedExport({ policy }),
      restored = await device(0);
    try {
      await restored.ops.btcSharedImport({ backup: stale, password: PW });
      const fresh = await restored.ops.btcSharedApprove({
        policy,
        proposal: p,
        confirmation: confirm(restored, message),
      });
      expect(fresh.nonce).not.toBe(own.nonce);
      expect(bytesToHex(B.bitcoinSigningSid(policy, p, [fresh, { from: 2, nonce: '33'.repeat(32) }]))).not.toBe(
        bytesToHex(B.bitcoinSigningSid(policy, p, [own, { from: 2, nonce: '33'.repeat(32) }])),
      );
    } finally {
      restored.worker.lock();
      restored.store.lock();
      restored.keys.lock();
    }
  });
  it('persists a real quorum transaction and restores it without releasing inputs or reusing change', async () => {
    let p!: B.SharedBitcoinProposal, final!: { txid: string; raw: string; vsize: number };
    for (let attempt = 0; attempt < 16; attempt++) {
      p = proposal();
      const message = bytesToHex(B.sharedBitcoinMessage(policy, p));
      const consents = await Promise.all(
        devices
          .slice(0, 2)
          .map((d) => d.ops.btcSharedApprove({ policy, proposal: p, confirmation: confirm(d, message) })),
      );
      const r1 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.btcSharedRound({ policy, proposal: p, consents, round: 1, inputs: [] })),
      );
      const r2 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.btcSharedRound({ policy, proposal: p, consents, round: 2, inputs: r1 })),
      );
      const r3 = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.btcSharedRound({ policy, proposal: p, consents, round: 3, inputs: r2 })),
      );
      let approval: B.BitcoinApproval;
      try {
        approval = B.combineBitcoinApproval(policy, p, r1, r2, r3, Date.now(), consents);
      } catch (error) {
        if (attempt === 15) throw error;
        continue;
      }
      const partials = await Promise.all(
        devices.slice(0, 2).map((d) => d.ops.btcSharedNativeSign({ policy, proposal: p, approval })),
      );
      final = await devices[0]!.ops.btcSharedFinalize({
        policy,
        proposal: p,
        approval,
        partials: partials.map((p) => p.partial),
      });
      break;
    }
    expect(B.verifySavedBitcoinTransaction(policy, p, final.raw).txid).toBe(final.txid);
    const d = devices[0]!,
      backup = await d.ops.btcSharedExport({ policy }),
      restored = await device(0);
    try {
      await restored.ops.btcSharedImport({ backup, password: PW });
      const state = await restored.ops.btcSharedStatus({ policy });
      expect(state.next).toBe(1);
      expect(Object.values(state.reservations)).toContain(p.id);
      expect(state.records![p.id]!.consent).toBeUndefined();
      vi.useFakeTimers();
      vi.setSystemTime(p.expiresAt + 60000);
      expect((await restored.ops.btcSharedSaved({ policy, id: p.id })).final?.txid).toBe(final.txid);
      vi.useRealTimers();
      await restored.ops.btcSharedReconcile({ policy, id: p.id, txid: final.txid, status: 'confirmed' });
      expect(Object.values((await restored.ops.btcSharedStatus({ policy })).reservations)).toContain(p.id);
      const plain = await d.store.openBitcoinBackup(backup, PW),
        edited = JSON.parse(new TextDecoder().decode(plain));
      plain.fill(0);
      edited.state.records[p.id].final.raw = '00';
      const tampered = await d.store.sealBitcoinBackup(
        backup.policyId,
        new TextEncoder().encode(JSON.stringify(edited)),
      );
      await expect(restored.ops.btcSharedImport({ backup: tampered, password: PW })).rejects.toThrow();
      await expect(restored.ops.btcSharedImport({ backup, password: 'wrong test password' })).rejects.toThrow();
      await expect(restored.store.openHederaBackup(backup, PW)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      restored.worker.lock();
      restored.keys.lock();
      restored.store.lock();
    }
    const wrong = await device(0, 'another-native-wallet');
    try {
      await expect(wrong.ops.btcSharedImport({ backup, password: PW })).rejects.toThrow(/another native wallet/);
    } finally {
      wrong.worker.lock();
      wrong.keys.lock();
      wrong.store.lock();
    }
  });
});
