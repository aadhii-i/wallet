import { readFile, writeFile } from 'node:fs/promises';
import { it, expect } from 'vitest';
import { HDKeyring } from '@qd/wallet-core';
import { dealerKeyGen, QdParty, encodePublicKey } from '@qd/qd-crypto';
import * as B from '@qd/bitcoin';
import * as H from '@qd/hedera';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex } from '@qd/wallet-core';
import { nativeMigrationFields, type NativeMigrationManifest } from '@qd/rpc';

const fixture = new URL('../../../../docs/api/native-policy-fixture.json', import.meta.url);
type Entry = {
  chain: 'bitcoin' | 'hedera';
  policy: B.BitcoinSharedPolicy | H.HederaSharedPolicy;
  policyId: string;
  addresses?: { branch: 0 | 1; index: number; address: string; script: string }[];
  thresholdEncoding?: string;
};

// Explicit developer-only fixture regeneration. Public enrollments, signatures,
// addresses and group public keys only; never shares, seeds or private keys.
async function generate(side: 0 | 1): Promise<Entry[]> {
  const keys: HDKeyring[] = [];
  try {
    const dealt = dealerKeyGen(2, 3),
      publicKey = B.bitcoinWireText(encodePublicKey(new QdParty(dealt.shares[0]!).publicKey(7)));
    for (let i = 0; i < 3; i++)
      keys.push(
        await HDKeyring.fromMnemonic(
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
          `public-contract-${i}`,
        ),
      );
    const common =
      side === 0
        ? {
            walletId: '11111111-1111-4111-8111-111111111111',
            accountId: '22222222-2222-4222-8222-222222222222',
            keygenId: '33333333-3333-4333-8333-333333333333',
            membershipVersion: 3,
          }
        : {
            walletId: '55555555-5555-4555-8555-555555555555',
            accountId: '66666666-6666-4666-8666-666666666666',
            keygenId: '77777777-7777-4777-8777-777777777777',
            membershipVersion: 3,
          };
    const bitcoin = B.createBitcoinPolicy(
      keys.map((key, i) => {
        const entry = {
          ...common,
          network: 'testnet4' as const,
          participantId: `${side === 0 ? '44444444-4444-4444-8444-44444444444' : '88888888-8888-4888-8888-88888888888'}${i}`,
          partyIndex: i + 1,
          derivationIndex: 7,
          threshold: 2,
          parties: 3,
          xpub: key.btcSharedRoot({ ...common, network: 'testnet4' }),
          raccoonPublicKey: publicKey,
        };
        return key.withBtcSharedPrivateKey({ ...common, network: 'testnet4' }, 0, 0, (privateKey) =>
          B.signBitcoinEnrollment(entry, privateKey),
        );
      }),
    );
    const hedera = H.createHederaPolicy(
      keys.map((key, i) => {
        const entry = {
          ...common,
          network: 'testnet' as const,
          participantId: `${side === 0 ? '44444444-4444-4444-8444-44444444444' : '88888888-8888-4888-8888-88888888888'}${i}`,
          partyIndex: i + 1,
          derivationIndex: 7,
          threshold: 2,
          parties: 3,
          publicKey: key.hederaSharedPublicKey({ ...common, network: 'testnet' }),
          raccoonPublicKey: publicKey,
        };
        return key.withHederaSharedPrivateKey({ ...common, network: 'testnet' }, (privateKey) =>
          H.signHederaEnrollment(entry, privateKey),
        );
      }),
    );
    return [
      {
        chain: 'bitcoin',
        policy: bitcoin,
        policyId: B.bitcoinPolicyId(bitcoin),
        addresses: (
          [
            { branch: 0, index: 0 },
            { branch: 1, index: 0 },
            { branch: 1, index: 7 },
          ] as const
        ).map((path) => {
          const output = B.sharedBitcoinOutput(bitcoin, path.branch, path.index);
          return {
            ...path,
            address: output.address,
            script: Array.from(output.script, (b) => b.toString(16).padStart(2, '0')).join(''),
          };
        }),
      },
      { chain: 'hedera', policy: hedera, policyId: H.hederaPolicyId(hedera), thresholdEncoding: H.hederaThresholdKeyHex(hedera) },
    ];
  } finally {
    keys.forEach((key) => key.lock());
  }
}
it('matches the public native-policy contract consumed independently by Go', async () => {
  if (process.env.QD_GENERATE_NATIVE_FIXTURE === '1')
    await writeFile(fixture, JSON.stringify([...(await generate(0)), ...(await generate(1))], null, 2) + '\n');
  const entries = JSON.parse(await readFile(fixture, 'utf8')) as Entry[];
  for (const entry of entries) {
    if (entry.chain === 'bitcoin') {
      const policy = entry.policy as B.BitcoinSharedPolicy;
      expect(B.bitcoinPolicyId(policy)).toBe(entry.policyId);
      for (const path of entry.addresses!)
        expect(B.sharedBitcoinOutput(policy, path.branch, path.index).address).toBe(path.address);
    } else {
      const policy = entry.policy as H.HederaSharedPolicy;
      expect(H.hederaPolicyId(policy)).toBe(entry.policyId);
      expect(H.hederaThresholdKeyHex(policy)).toBe(entry.thresholdEncoding);
    }
  }
});

// A separate public wire-contract fixture exercises native transaction parsing
// in Go. Funding and migration bytes are synthetic and never submitted.
it('binds native migration reviews and exact unsigned transactions across languages', async () => {
  const entries = JSON.parse(await readFile(fixture, 'utf8')) as Entry[];
  const source = entries[0]!.policy as B.BitcoinSharedPolicy,
    target = entries[2]!.policy as B.BitcoinSharedPolicy;
  const funding = new Transaction({ allowUnknownInputs: true });
  funding.addInput({ txid: '11'.repeat(32), index: 0 });
  const output = B.sharedBitcoinOutput(source, 0, 0);
  funding.addOutput({ amount: 100000n, script: output.script });
  funding.updateInput(0, { finalScriptSig: new Uint8Array([0]) });
  const coin: B.SharedBitcoinCoin = {
    txid: funding.id,
    vout: 0,
    value: 100000n,
    scriptPubKey: bytesToHex(output.script),
    confirmations: 6,
    branch: 0,
    addressIndex: 0,
    previousTx: bytesToHex(funding.toBytes(true, false)),
  };
  const migrationId = '99999999-9999-4999-8999-999999999999';
  const p = B.makeSharedBitcoinMigration(source, target, migrationId, [coin], 2, [1, 2]);
  const h = H.makeHederaKeyUpdate(
    entries[1]!.policy as H.HederaSharedPolicy,
    entries[3]!.policy as H.HederaSharedPolicy,
    '0.0.9001',
    migrationId,
    [1, 2],
    [1, 2],
    100000000n,
  );
  const wire = new URL('../../../../docs/api/native-migration-fixture.json', import.meta.url);
  if (process.env.QD_GENERATE_NATIVE_FIXTURE === '1')
    await writeFile(
      wire,
      JSON.stringify(
        {
          migrationId,
          bitcoin: {
            proposal: p,
            txid: B.validateSharedBitcoinProposal(source, p).id,
            coin: { txid: coin.txid, vout: 0, value: '100000', branch: 0, index: 0 },
            script: coin.scriptPubKey,
          },
          hedera: h,
        },
        null,
        2,
      ) + '\n',
    );
  const saved = JSON.parse(await readFile(wire, 'utf8'));
  expect(
    B.validateSharedBitcoinProposal(
      source,
      saved.bitcoin.proposal,
      Math.min(Date.now(), saved.bitcoin.proposal.expiresAt - 1),
    ).id,
  ).toBe(saved.bitcoin.txid);
  H.validateHederaProposal(
    entries[1]!.policy as H.HederaSharedPolicy,
    saved.hedera.source,
    saved.hedera.source.expiresAt - 1,
  );
  const nativeOutput = B.sharedBitcoinOutput(target, 0, 0);
  const manifest = {
    version: 1,
    id: migrationId,
    sourceWalletId: source.context.walletId,
    targetWalletId: target.context.walletId,
    sourceEpoch: 3,
    targetEpoch: 3,
    sourceKeygenId: source.context.keygenId,
    targetKeygenId: target.context.keygenId,
    sourceRoster: source.members.map((m) => ({
      id: m.participantId,
      name: 'Public <fixture> participant',
      role: 'member',
      deviceKey: '',
    })),
    targetRoster: target.members.map((m) => ({
      id: m.participantId,
      name: 'Public & incoming participant',
      role: 'member',
      deviceKey: '',
    })),
    intents: [
      {
        id: migrationId,
        chain: 'bitcoin',
        sourceAccountId: source.context.accountId,
        targetAccountId: target.context.accountId,
        sourcePolicyId: B.bitcoinPolicyId(source),
        targetPolicyId: B.bitcoinPolicyId(target),
        sourcePolicy: source,
        targetPolicy: target,
        bitcoinCoins: [saved.bitcoin.coin],
        changeCursor: 0,
        destination: nativeOutput.address,
        destinationScript: bytesToHex(nativeOutput.script),
        hederaAccountId: '',
        targetKey: '',
        maxFee: '100000',
      },
    ],
    requiredApprovals: 2,
    requiredTargetApprovals: 2,
  } as unknown as NativeMigrationManifest;
  const digest = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(nativeMigrationFields(manifest)))),
    ),
  );
  const manifestFixture = new URL('../../../../docs/api/native-migration-review-fixture.json', import.meta.url);
  if (process.env.QD_GENERATE_NATIVE_FIXTURE === '1')
    await writeFile(manifestFixture, JSON.stringify({ manifest, digest }, null, 2) + '\n');
  const review = JSON.parse(await readFile(manifestFixture, 'utf8'));
  expect(review.digest).toBe(digest);
});
