import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Transaction, TEST_NETWORK, p2wsh, p2ms } from '@scure/btc-signer';
import { HDKeyring, btcChangePath, bytesToHex, fromHex, hashPayload, type SigningPayload } from '@qd/wallet-core';
import { BITCOIN_NETWORKS, type BitcoinNetwork } from '@qd/blockchain';
import {
  BitcoinAdapter,
  BitcoinSigner,
  buildPsbt,
  dustLimit,
  extractSignedTx,
  scriptPubKeyHex,
  selectCoins,
  validateUtxos,
  verifyPreviousOutput,
  type BtcUtxo,
  type BitcoinDataSource,
  type BitcoinUnsignedTx,
} from '../src';

// Public BIP-39 test vector, used only for synthetic local transactions.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = BITCOIN_NETWORKS.find((n) => n.id === 'btc-testnet4')! as BitcoinNetwork;
let keys: HDKeyring;
beforeAll(async () => {
  keys = await HDKeyring.fromMnemonic(phrase);
});
afterAll(() => keys.lock());

function coin(address: string, value: bigint, id = 1): BtcUtxo {
  const tx = new Transaction({ allowUnknownInputs: true });
  tx.addInput({ txid: id.toString(16).padStart(64, '0'), index: 0 });
  tx.addOutputAddress(address, value, TEST_NETWORK);
  tx.updateInput(0, { finalScriptSig: new Uint8Array([0]) });
  return {
    txid: tx.id,
    vout: 0,
    value,
    scriptPubKey: scriptPubKeyHex(address),
    confirmations: 6,
    previousTx: bytesToHex(tx.toBytes(true, false)),
  };
}

function build(type: 'p2wpkh' | 'p2tr' = 'p2wpkh', inputs?: BtcUtxo[], next = 0): BitcoinUnsignedTx {
  const from = keys.btcAddress(0, type, 'testnet4');
  return buildPsbt({
    network,
    addressType: type,
    from,
    to: keys.btcAddress(8, type, 'testnet4'),
    changeAddress: keys.btcChangeAddress(0, next, type, 'testnet4'),
    changeIndex: next,
    amount: 40_000n,
    selection: selectCoins(inputs ?? [coin(from, 90_000n)], 40_000n, 2, type),
  });
}

function payload(tx: BitcoinUnsignedTx): SigningPayload {
  return {
    kind: 'btc-psbt',
    network: 'testnet4',
    addressType: tx.addressType,
    from: tx.from,
    psbt: tx.psbt,
    review: tx.review,
  };
}
function sign(unsigned: BitcoinUnsignedTx) {
  const signer = new BitcoinSigner(keys),
    p = payload(unsigned);
  const result = signer.sign({
    account: { id: 'test', hdIndex: 0 },
    payload: p,
    confirmation: signer.confirmations.issue(p),
  });
  if (result.kind !== 'btc-psbt') throw new Error('unexpected signature');
  return extractSignedTx(result.psbt);
}

describe('recoverable internal keys', () => {
  it('funds a P2WSH shared destination without changing the personal signing policy',()=>{
    const native=[1,2,3].map(i=>keys.withBtcPrivateKey(i,'p2wpkh','testnet4',key=>secp256k1.getPublicKey(key,true)));
    const destination=p2wsh(p2ms(2,native),TEST_NETWORK).address;
    const from=keys.btcAddress(0,'p2wpkh','testnet4');
    const unsigned=buildPsbt({network,addressType:'p2wpkh',from,to:destination,
      changeAddress:keys.btcChangeAddress(0,0,'p2wpkh','testnet4'),changeIndex:0,amount:40_000n,
      selection:selectCoins([coin(from,90_000n)],40_000n,2,'p2wpkh','p2wsh')});
    expect(Transaction.fromRaw(fromHex(sign(unsigned).rawHex)).getOutputAddress(0,TEST_NETWORK)).toBe(destination);
  });
  it('preserves legacy paths and separates account, index, type, and network', async () => {
    expect(btcChangePath(2, 3, 'p2wpkh', 'testnet4')).toBe("m/84'/1'/2'/1/3");
    const all = new Set([
      keys.btcAddress(0, 'p2wpkh', 'testnet4'),
      keys.btcChangeAddress(0, 0, 'p2wpkh', 'testnet4'),
      keys.btcChangeAddress(0, 1, 'p2wpkh', 'testnet4'),
      keys.btcChangeAddress(1, 0, 'p2wpkh', 'testnet4'),
      keys.btcChangeAddress(0, 0, 'p2tr', 'testnet4'),
      keys.btcChangeAddress(0, 0, 'p2wpkh', 'mainnet'),
    ]);
    expect(all.size).toBe(6);
    expect(keys.btcChangeDescriptor(2, 'p2wpkh', 'testnet4').descriptor).toContain("/84'/1'/2']");
    expect(keys.btcChangeDescriptor(2, 'p2wpkh', 'testnet4').descriptor).toMatch(/\/1\/\*\)$/);
    const restored = await HDKeyring.fromMnemonic(phrase);
    expect(restored.btcChangeAddress(2, 3, 'p2wpkh', 'testnet4')).toBe(
      keys.btcChangeAddress(2, 3, 'p2wpkh', 'testnet4'),
    );
    restored.lock();
    expect(() => btcChangePath(0, -1, 'p2wpkh', 'testnet4')).toThrow();
  });

  for (const type of ['p2wpkh', 'p2tr'] as const)
    it(`spends legacy plus previous change with ${type}`, () => {
      const first = build(type);
      const sent = sign(first);
      const change: BtcUtxo = {
        txid: sent.txid,
        vout: 1,
        value: first.change,
        scriptPubKey: scriptPubKeyHex(first.changeAddress),
        confirmations: 1,
        previousTx: sent.rawHex,
        address: first.changeAddress,
        changeIndex: 0,
      };
      const legacy = { ...coin(first.from, 20_000n, 2), address: first.from };
      const second = build(type, [legacy, change], 1);
      // Force both inputs to be needed, rather than merely testing two available coins.
      const amount = legacy.value + change.value - 2000n;
      const combined = buildPsbt({
        network,
        addressType: type,
        from: first.from,
        to: second.to,
        changeAddress: keys.btcChangeAddress(0, 1, type, 'testnet4'),
        changeIndex: 1,
        amount,
        selection: selectCoins([legacy, change], amount, 2, type),
      });
      expect(combined.inputCount).toBe(2);
      const result = sign(combined);
      const decoded = Transaction.fromRaw(fromHex(result.rawHex));
      expect(decoded.getOutputAddress(1, TEST_NETWORK)).toBe(combined.changeAddress);
      expect(decoded.getOutput(0).amount).toBe(amount);
    });
});

describe('untrusted UTXOs and signed intent', () => {
  it('rejects a signed response for a different reviewed transaction', () => {
    const expected = build();
    const other = build('p2wpkh', [coin(expected.from, 100_000n, 3)]);
    const signer = new BitcoinSigner(keys);
    const p = payload(other);
    const signature = signer.sign({
      account: { id: 'test', hdIndex: 0 },
      payload: p,
      confirmation: signer.confirmations.issue(p),
    });
    const source = {} as BitcoinDataSource;
    const adapter = new BitcoinAdapter({ network, dataSource: source });
    expect(() => adapter.assembleSigned(expected, signature)).toThrow(/differs/);
    expect(adapter.assembleSigned(other, signature).hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('rejects duplicate, negative, malformed, and unconfirmed inputs', () => {
    const u = coin(keys.btcAddress(0, 'p2wpkh', 'testnet4'), 100_000n);
    expect(() => validateUtxos([u, u])).toThrow(/Duplicate/);
    for (const invalid of [
      { ...u, value: -1n },
      { ...u, vout: 1.5 },
      { ...u, confirmations: -1 },
      { ...u, txid: 'bad' },
    ]) {
      expect(() => validateUtxos([invalid])).toThrow();
    }
    expect(() => selectCoins([{ ...u, confirmations: 0 }], 40_000n, 1, 'p2wpkh')).toThrow();
  });
  it('rejects substituted values, scripts, transaction ids and output indices', () => {
    const u = coin(keys.btcAddress(0, 'p2wpkh', 'testnet4'), 100_000n);
    for (const invalid of [
      { ...u, value: u.value + 1n },
      { ...u, scriptPubKey: '0014' + '00'.repeat(20) },
      { ...u, txid: 'ff'.repeat(32) },
      { ...u, vout: 9 },
    ])
      expect(() => verifyPreviousOutput(invalid)).toThrow();
    expect(() => verifyPreviousOutput(u)).not.toThrow();
  });
  it('checks coinbase maturity from the raw transaction', () => {
    const tx = new Transaction({ allowUnknownInputs: true });
    tx.addInput({ txid: '00'.repeat(32), index: 0xffffffff });
    const address = keys.btcAddress(0, 'p2wpkh', 'testnet4');
    tx.addOutputAddress(address, 50_000n, TEST_NETWORK);
    tx.updateInput(0, { finalScriptSig: new Uint8Array([1, 1]) });
    const u = {
      txid: tx.id,
      vout: 0,
      value: 50_000n,
      scriptPubKey: scriptPubKeyHex(address),
      confirmations: 99,
      previousTx: bytesToHex(tx.toBytes(true, false)),
    };
    expect(() => verifyPreviousOutput(u)).toThrow(/mature/);
    expect(() => verifyPreviousOutput({ ...u, confirmations: 100 })).not.toThrow();
  });
  it('binds recipient, amount, fee and derivation hints to confirmation', () => {
    const original = payload(build());
    if (original.kind !== 'btc-psbt') throw new Error();
    const before = hashPayload(original);
    for (const review of [
      { ...original.review!, amount: '1' },
      { ...original.review!, maxFee: '999999' },
      { ...original.review!, changeIndex: 5 },
      { ...original.review!, inputChanges: [1] },
    ]) {
      expect(hashPayload({ ...original, review })).not.toBe(before);
    }
  });
  it('refuses a forged change address, recipient, fee, and signature hash', () => {
    const unsigned = build();
    const signer = new BitcoinSigner(keys);
    const p = payload(unsigned);
    if (p.kind !== 'btc-psbt') throw new Error();
    for (const review of [
      { ...p.review!, changeIndex: 1 },
      { ...p.review!, recipient: keys.btcAddress(3, 'p2wpkh', 'testnet4') },
      { ...p.review!, maxFee: '0' },
      { ...p.review!, inputChanges: [7] },
    ]) {
      expect(() => signer.validate({ account: { id: 'test', hdIndex: 0 }, payload: { ...p, review } })).toThrow();
    }
    const tx = Transaction.fromPSBT(base64.decode(unsigned.psbt));
    tx.updateInput(0, { sighashType: 0x83 });
    expect(() =>
      signer.validate({ account: { id: 'test', hdIndex: 0 }, payload: { ...p, psbt: base64.encode(tx.toPSBT()) } }),
    ).toThrow(/signature hash/);
    expect(() => signer.validate({ account: { id: 'test', hdIndex: 1 }, payload: p })).toThrow(/Sender/);
  });
  it('uses script-aware dust bounds', () => {
    expect(dustLimit('p2wpkh')).toBe(294n);
    expect(dustLimit('p2tr')).toBe(330n);
  });
  it('rechecks spent coins, and Max leaves room for the fee', async () => {
    const unsigned = build();
    let available = unsigned.inputs.slice();
    const source: BitcoinDataSource = {
      chain: 'testnet4',
      getTipHeight: async () => 100n,
      getUtxos: async () => available,
      getRawTransaction: async () => available[0]!.previousTx!,
      getFees: async () => ({ low: 1, market: 2, aggressive: 3, tipHeight: 100, quotedAt: Date.now() }),
      getTransaction: async () => null,
      getHistory: async () => ({ items: [] }),
      broadcast: async () => '',
    };
    const adapter = new BitcoinAdapter({
      network,
      dataSource: source,
      wallet: {
        discover: async () => ({ addresses: [{ address: unsigned.from }], highestUsed: -1 }),
        change: async () => ({ address: unsigned.changeAddress, index: 0 }),
        unavailable: async () => new Set(),
      },
    });
    expect(await adapter.maxAmount(unsigned.from)).toBeLessThan(available[0]!.value);
    await expect(adapter.revalidate(unsigned)).resolves.toBeUndefined();
    available = [];
    await expect(adapter.revalidate(unsigned)).rejects.toThrow(/no longer/);
  });
});
