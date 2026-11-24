import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { bech32 } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Transaction, TEST_NETWORK } from '@scure/btc-signer';
import { HDKeyring, bytesToHex, fromHex, type BitcoinSharedContext } from '@qd/wallet-core';
import {
  dealerKeyGen,
  QdParty,
  encodePublicKey,
  encodeRound1,
  encodeRound2,
  encodeRound3,
  decodeRound1,
  decodeRound2,
  type KeyShare,
} from '@qd/qd-crypto';
import {
  bitcoinPolicyId,
  bitcoinWireBytes,
  bitcoinWireText,
  combineBitcoinApproval,
  createBitcoinPolicy,
  finalizeSharedBitcoin,
  makeSharedBitcoinProposal,
  sharedBitcoinMessage,
  sharedBitcoinOutput,
  signBitcoinEnrollment,
  signSharedBitcoin,
  verifyBitcoinApproval,
  type BitcoinSharedPolicy,
  type BitcoinApproval,
  type SharedBitcoinProposal,
  type SharedBitcoinCoin,
} from '../src';

const context: BitcoinSharedContext = {
  walletId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  keygenId: '33333333-3333-4333-8333-333333333333',
  membershipVersion: 3,
  network: 'testnet4',
};
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys: HDKeyring[] = [];
let shares: KeyShare[], policy: BitcoinSharedPolicy, coin: SharedBitcoinCoin;

beforeAll(async () => {
  for (let i = 0; i < 3; i++) keys.push(await HDKeyring.fromMnemonic(phrase, `test-participant-${i}`));
  shares = dealerKeyGen(2, 3).shares;
  const pk = bitcoinWireText(encodePublicKey(new QdParty(shares[0]!).publicKey(7)));
  policy = createBitcoinPolicy(
    keys.map((key, i) => {
      const entry = {
        ...context,
        participantId: `44444444-4444-4444-8444-44444444444${i}`,
        partyIndex: i + 1,
        derivationIndex: 7,
        threshold: 2,
        parties: 3,
        xpub: key.btcSharedRoot(context),
        raccoonPublicKey: pk,
      };
      return key.withBtcSharedPrivateKey(context, 0, 0, (privateKey) => signBitcoinEnrollment(entry, privateKey));
    }),
  );
  const output = sharedBitcoinOutput(policy, 0, 0),
    funding = new Transaction({ allowUnknownInputs: true });
  funding.addInput({ txid: '11'.repeat(32), index: 0 });
  funding.addOutput({ amount: 100_000n, script: output.script });
  funding.updateInput(0, { finalScriptSig: new Uint8Array([0]) });
  coin = {
    txid: funding.id,
    vout: 0,
    value: 100_000n,
    scriptPubKey: bytesToHex(output.script),
    confirmations: 6,
    branch: 0,
    addressIndex: 0,
    previousTx: bytesToHex(funding.toBytes(true, false)),
  };
});
afterAll(() => keys.forEach((key) => key.lock()));

function proposal() {
  return makeSharedBitcoinProposal(policy, [coin], keys[0]!.btcAddress(9, 'p2wpkh', 'testnet4'), 40_000n, 2, 0, [1, 2]);
}
function approve(p: SharedBitcoinProposal): BitcoinApproval {
  const parties = shares.slice(0, 2).map((key) => new QdParty(key));
  const request = {
    sid: fromHex(p.sid),
    act: p.active,
    derivationIndex: policy.derivationIndex,
    msg: sharedBitcoinMessage(policy, p),
  };
  const r1 = parties.map((party) => ({
    from: party.index,
    payload: bitcoinWireText(encodeRound1(party.round1(request))),
  }));
  const first = r1.map((m) => decodeRound1(m.from, bitcoinWireBytes(m.payload)));
  const r2 = parties.map((party) => ({
    from: party.index,
    payload: bitcoinWireText(encodeRound2(party.round2(request.sid, first), request.act)),
  }));
  const second = r2.map((m) => decodeRound2(m.from, bitcoinWireBytes(m.payload), request.act));
  const r3 = parties.map((party) => ({
    from: party.index,
    payload: bitcoinWireText(encodeRound3(party.round3(request.sid, second))),
  }));
  return combineBitcoinApproval(policy, p, r1, r2, r3);
}
function approved() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const p = proposal();
    try {
      return { p, approval: approve(p) };
    } catch (error) {
      if (attempt === 15) throw error;
    }
  }
  throw new Error('Signing failed');
}
function partial(p: SharedBitcoinProposal, approval: BitcoinApproval, index: number) {
  return signSharedBitcoin(policy, p, approval, index + 1, (branch, address, fn) =>
    keys[index]!.withBtcSharedPrivateKey(context, branch, address, fn),
  );
}

describe('Bitcoin-enforced quorum plus Threshold Raccoon approval', () => {
  it('never uses locale-dependent ordering for native keys', () => {
    const expected = sharedBitcoinOutput(policy, 0, 0).address;
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('Locale-dependent ordering');
    });
    try {
      expect(sharedBitcoinOutput(policy, 0, 0).address).toBe(expected);
    } finally {
      locale.mockRestore();
    }
  });
  it('creates a distinct shared P2WSH policy with proved, independently held native keys', () => {
    expect(policy.nativeThreshold).toBe(2);
    expect(policy.raccoonThreshold).toBe(2);
    expect(sharedBitcoinOutput(policy, 0, 0).address).toMatch(/^tb1q/);
    expect(sharedBitcoinOutput(policy, 0, 0).script.length).toBe(34);
    expect(sharedBitcoinOutput(policy, 1, 0).address).not.toBe(sharedBitcoinOutput(policy, 0, 0).address);
    expect(keys[0]!.btcAddress(0, 'p2wpkh', 'testnet4')).not.toBe(sharedBitcoinOutput(policy, 0, 0).address);
  });
  it('serializes Raccoon round messages, verifies their signature, collects native signatures and finalizes', () => {
    const { p, approval } = approved();
    expect(() => verifyBitcoinApproval(policy, p, approval)).not.toThrow();
    const a = partial(p, approval, 0),
      b = partial(p, approval, 1);
    const signed = finalizeSharedBitcoin(policy, p, approval, [a, b]);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    const raw = Transaction.fromRaw(fromHex(signed.raw));
    expect(raw.getOutputAddress(0, TEST_NETWORK)).toBe(p.recipient);
    expect(raw.getOutputAddress(1, TEST_NETWORK)).toBe(sharedBitcoinOutput(policy, 1, 0).address);
    expect(raw.getInput(0).finalScriptWitness!.length).toBe(4);
  });
  it('a single native key cannot satisfy the Bitcoin quorum, even with valid Raccoon approval', () => {
    const { p, approval } = approved(),
      one = partial(p, approval, 0);
    expect(() => finalizeSharedBitcoin(policy, p, approval, [one])).toThrow(/quorum/);
    expect(() => finalizeSharedBitcoin(policy, p, approval, [one, one])).toThrow();
  });
  it('blocks native signing with missing, altered or expired Raccoon authorization', () => {
    const { p, approval } = approved();
    const bytes = bitcoinWireBytes(approval.signature);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => partial(p, { ...approval, signature: bitcoinWireText(bytes) }, 0)).toThrow();
    expect(() => partial({ ...p, id: crypto.randomUUID() }, approval, 0)).toThrow();
    expect(() => verifyBitcoinApproval(policy, p, approval, p.expiresAt + 1)).toThrow();
    expect(() => partial({ ...p, recipient: keys[1]!.btcAddress(0, 'p2wpkh', 'testnet4') }, approval, 0)).toThrow();
  });
  it('rejects weakened policies, duplicate members, forged enrollment and wrong native keys', () => {
    expect(() => bitcoinPolicyId({ ...policy, nativeThreshold: 1 })).toThrow();
    expect(() => createBitcoinPolicy([policy.members[0]!, policy.members[0]!, policy.members[2]!])).toThrow();
    expect(() =>
      createBitcoinPolicy(policy.members.map((m, i) => (i === 1 ? { ...m, proof: '00'.repeat(64) } : m))),
    ).toThrow();
    const { p, approval } = approved();
    expect(() =>
      signSharedBitcoin(policy, p, approval, 1, (branch, index, fn) =>
        keys[2]!.withBtcSharedPrivateKey(context, branch, index, fn),
      ),
    ).toThrow(/not enrolled/);
  });
  it('does not depend on JSON object key order for the policy fingerprint', () => {
    const reordered = JSON.parse(JSON.stringify(policy, undefined, 2));
    reordered.context = Object.fromEntries(Object.entries(reordered.context).reverse());
    expect(bitcoinPolicyId(reordered)).toBe(bitcoinPolicyId(policy));
  });
  it.skipIf(!process.env.BITCOIND_BIN)(
    'Bitcoin Core accepts the native quorum and spending restored shared change',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'qd-bitcoin-regtest-'));
      const port = 25000 + Math.floor(Math.random() * 15000);
      const proc = spawn(
        process.env.BITCOIND_BIN!,
        [
          '-regtest',
          '-server=1',
          '-listen=0',
          '-dnsseed=0',
          '-discover=0',
          '-connect=0',
          '-printtoconsole=0',
          `-datadir=${directory}`,
          `-rpcport=${port}`,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
      let startupError: Error | undefined;
      proc.on('error', (error) => {
        startupError = error;
      });
      const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
        const cookie = (await readFile(join(directory, 'regtest', '.cookie'), 'utf8')).trim();
        const response = await fetch(`http://127.0.0.1:${port}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(cookie).toString('base64')}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const data = (await response.json()) as { result: T; error?: { message: string } };
        if (data.error) throw new Error(data.error.message);
        return data.result;
      };

      try {
        for (let attempt = 0; ; attempt++) {
          if (startupError) throw startupError;
          try {
            expect((await rpc<{ chain: string }>('getblockchaininfo')).chain).toBe('regtest');
            break;
          } catch (error) {
            if (attempt >= 100) throw error;
            await new Promise((r) => setTimeout(r, 100));
          }
        }

        const originalCoin = coin;
        try {
          const regAddress = (address: string) => {
            const decoded = bech32.decode(address as `tb1${string}`);
            return bech32.encode('bcrt', decoded.words);
          };
          const blocks = await rpc<string[]>('generatetoaddress', [
            101,
            regAddress(sharedBitcoinOutput(policy, 0, 0).address),
          ]);
          const block = await rpc<{ tx: { txid: string }[] }>('getblock', [blocks[0], 2]);
          const raw = await rpc<string>('getrawtransaction', [block.tx[0]!.txid, false, blocks[0]]);
          const previous = Transaction.fromRaw(fromHex(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });
          coin = {
            txid: previous.id,
            vout: 0,
            value: previous.getOutput(0).amount!,
            scriptPubKey: bytesToHex(sharedBitcoinOutput(policy, 0, 0).script),
            confirmations: 101,
            coinbase: true,
            branch: 0,
            addressIndex: 0,
            previousTx: raw,
          };
          for (let index = 0; index < 2; index++) {
            if (index === 1)
              for (let i = 0; i < keys.length; i++) {
                keys[i]!.lock();
                keys[i] = await HDKeyring.fromMnemonic(phrase, `test-participant-${i}`);
              }
            let signed: ReturnType<typeof finalizeSharedBitcoin> | undefined;
            for (let attempt = 0; attempt < 16; attempt++) {
              const p = makeSharedBitcoinProposal(
                policy,
                [coin],
                keys[0]!.btcAddress(9, 'p2wpkh', 'testnet4'),
                40_000n,
                2,
                index,
                [1, 2],
              );
              let approval: BitcoinApproval;
              try {
                approval = approve(p);
              } catch (error) {
                if (attempt === 15) throw error;
                continue;
              }
              const one = partial(p, approval, 0);
              expect(() => finalizeSharedBitcoin(policy, p, approval, [one])).toThrow(/quorum/);
              signed = finalizeSharedBitcoin(policy, p, approval, [one, partial(p, approval, 1)]);
              break;
            }
            expect(signed).toBeDefined();
            const accepted = await rpc<{ allowed: boolean }[]>('testmempoolaccept', [[signed!.raw]]);
            expect(accepted[0], JSON.stringify(accepted)).toMatchObject({ allowed: true });
            expect(await rpc('sendrawtransaction', [signed!.raw])).toBe(signed!.txid);
            await rpc('generatetoaddress', [1, regAddress(sharedBitcoinOutput(policy, 0, 0).address)]);
            const change = Transaction.fromRaw(fromHex(signed!.raw)).getOutput(1);
            expect(bytesToHex(change.script!)).toBe(bytesToHex(sharedBitcoinOutput(policy, 1, index).script));
            coin = {
              txid: signed!.txid,
              vout: 1,
              value: change.amount!,
              scriptPubKey: bytesToHex(change.script!),
              confirmations: 1,
              branch: 1,
              addressIndex: index,
              previousTx: signed!.raw,
            };
          }
        } finally {
          coin = originalCoin;
        }
      } finally {
        try {
          await rpc('stop');
        } catch {}
        if (proc.exitCode === null)
          await Promise.race([new Promise((r) => proc.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
        if (proc.exitCode === null) proc.kill();
        const resolved = await realpath(directory),
          temporary = await realpath(tmpdir());
        if (!resolved.startsWith(resolve(temporary) + sep) || !basename(resolved).startsWith('qd-bitcoin-regtest-'))
          throw new Error('Unsafe temporary cleanup path');
        await rm(resolved, { recursive: true, force: true });
      }
    },
    120000,
  );
});
