import { describe, expect, it } from 'vitest';
import { TEST_NETWORK, Transaction } from '@scure/btc-signer';
import { HDKeyring, fromHex, type SigningPayload } from '@qd/wallet-core';
import { BITCOIN_NETWORKS, type BitcoinNetwork } from '@qd/blockchain';
import {
  BitcoinAdapter,
  BitcoinSigner,
  DUST_LIMIT_SATS,
  buildPsbt,
  checkBitcoinAddress,
  estimateVsize,
  extractSignedTx,
  scriptPubKeyHex,
  selectCoins,
  totalSats,
} from '../src';
import type { BitcoinDataSource, BtcUtxo } from '../src';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function network(id: string): BitcoinNetwork {
  const n = BITCOIN_NETWORKS.find((x) => x.id === id);
  if (!n) throw new Error(`missing ${id}`);
  return n;
}

function utxo(address: string, value: bigint, vout = 0, txid = '11'.repeat(32)): BtcUtxo {
  return { txid, vout, value, scriptPubKey: scriptPubKeyHex(address), confirmations: 6 };
}

describe('coin selection', () => {
  const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

  it('selects the smallest sufficient set, largest first', () => {
    const utxos = [utxo(address, 10_000n, 0), utxo(address, 60_000n, 1), utxo(address, 40_000n, 2)];
    const sel = selectCoins(utxos, 50_000n, 2, 'p2wpkh');
    expect(sel.inputs).toHaveLength(1);
    expect(sel.inputs[0]!.value).toBe(60_000n);
    expect(sel.total).toBe(60_000n);
    expect(sel.change).toBeGreaterThan(0n);
    expect(sel.total).toBe(50_000n + sel.fee + sel.change);
  });

  it('folds dust change into the fee', () => {
    // 50_000 target + 141 vB fee + 100 sats of dust change.
    const value = 50_241n;
    const sel = selectCoins([utxo(address, value)], 50_000n, 1, 'p2wpkh');
    expect(sel.change).toBe(0n);
    expect(sel.fee).toBe(value - 50_000n);
  });

  it('rejects insufficient funds', () => {
    expect(() => selectCoins([utxo(address, 1_000n)], 50_000n, 2, 'p2wpkh')).toThrow();
  });

  it('ignores dust outputs', () => {
    const utxos = [utxo(address, DUST_LIMIT_SATS - 1n), utxo(address, 50_000n)];
    expect(selectCoins(utxos, 40_000n, 1, 'p2wpkh').inputs).toHaveLength(1);
    expect(totalSats(utxos)).toBe(50_545n);
  });
});

describe('fee estimation', () => {
  it('grows with inputs and outputs and rounds up', () => {
    const one = estimateVsize(1, 'p2wpkh', 1);
    const two = estimateVsize(2, 'p2wpkh', 1);
    const withChange = estimateVsize(1, 'p2wpkh', 2);
    expect(two).toBeGreaterThan(one);
    expect(withChange).toBeGreaterThan(one);
    expect(Number.isInteger(one)).toBe(true);
  });

  it('charges 68 vB per P2WPKH input and 58 vB per P2TR input', () => {
    expect(estimateVsize(2, 'p2wpkh', 1) - estimateVsize(1, 'p2wpkh', 1)).toBe(68);
    expect(estimateVsize(2, 'p2tr', 1) - estimateVsize(1, 'p2tr', 1)).toBe(58);
  });
});

describe('address validation', () => {
  it('separates wrong-network from malformed addresses', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const tb = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const mainnet = network('btc-mainnet');
    expect(checkBitcoinAddress(keyring.btcAddress(0, 'p2wpkh', 'mainnet'), mainnet).valid).toBe(true);
    expect(checkBitcoinAddress(tb, mainnet).reason).toBe('network');
    const corrupted = `${tb.slice(0, -1)}${tb.endsWith('u') ? 'v' : 'u'}`;
    expect(checkBitcoinAddress(corrupted, network('btc-testnet4')).reason).toBe('checksum');
  });
});

describe('PSBT sign and extract', () => {
  it('builds, signs and extracts a P2WPKH transaction', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const to = keyring.btcAddress(1, 'p2wpkh', 'testnet4');
    const source = utxo(from, 100_000n);
    const selection = selectCoins([source], 50_000n, 2, 'p2wpkh');
    const unsigned = buildPsbt({
      network: net,
      addressType: 'p2wpkh',
      from,
      to,
      changeAddress: from,
      amount: 50_000n,
      selection,
    });
    expect(unsigned.inputCount).toBe(1);
    expect(unsigned.psbt.length).toBeGreaterThan(0);

    const signer = new BitcoinSigner(keyring);
    const payload: SigningPayload = {
      kind: 'btc-psbt',
      network: 'testnet4',
      from,
      addressType: 'p2wpkh',
      psbt: unsigned.psbt,
    };
    const result = signer.sign({
      account: { id: 'a', hdIndex: 0 },
      payload,
      confirmation: signer.confirmations.issue(payload),
    });
    expect(result.kind).toBe('btc-psbt');
    if (result.kind !== 'btc-psbt') throw new Error('unexpected');

    const extracted = extractSignedTx(result.psbt);
    expect(extracted.txid).toMatch(/^[0-9a-f]{64}$/);
    const tx = Transaction.fromRaw(fromHex(extracted.rawHex));
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutputAddress(0, TEST_NETWORK)).toBe(to);
    expect(tx.getOutput(0).amount).toBe(50_000n);
  });

  it('builds, signs and extracts a P2TR key-path transaction', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2tr', 'testnet4');
    const to = keyring.btcAddress(1, 'p2tr', 'testnet4');
    const selection = selectCoins([utxo(from, 200_000n)], 75_000n, 3, 'p2tr');
    const unsigned = buildPsbt({
      network: net,
      addressType: 'p2tr',
      from,
      to,
      changeAddress: from,
      amount: 75_000n,
      selection,
    });
    const signer = new BitcoinSigner(keyring);
    const payload: SigningPayload = {
      kind: 'btc-psbt',
      network: 'testnet4',
      from,
      addressType: 'p2tr',
      psbt: unsigned.psbt,
    };
    const result = signer.sign({
      account: { id: 'a', hdIndex: 0 },
      payload,
      confirmation: signer.confirmations.issue(payload),
    });
    if (result.kind !== 'btc-psbt') throw new Error('unexpected');
    const extracted = extractSignedTx(result.psbt);
    const tx = Transaction.fromRaw(fromHex(extracted.rawHex));
    expect(tx.getOutputAddress(0, TEST_NETWORK)).toBe(to);
  });

  it('refuses a PSBT whose input does not belong to the account', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const other = keyring.btcAddress(5, 'p2wpkh', 'testnet4');
    const selection = selectCoins([utxo(other, 100_000n)], 50_000n, 2, 'p2wpkh');
    const unsigned = buildPsbt({
      network: net,
      addressType: 'p2wpkh',
      from: other,
      to: from,
      changeAddress: other,
      amount: 50_000n,
      selection,
    });
    const signer = new BitcoinSigner(keyring);
    const payload: SigningPayload = {
      kind: 'btc-psbt',
      network: 'testnet4',
      from,
      addressType: 'p2wpkh',
      psbt: unsigned.psbt,
    };
    expect(() =>
      signer.sign({
        account: { id: 'a', hdIndex: 0 },
        payload,
        confirmation: signer.confirmations.issue(payload),
      }),
    ).toThrow(/does not belong/);
  });

  it('rejects a UTXO with incorrect scriptPubKey during PSBT building', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const other = keyring.btcAddress(5, 'p2wpkh', 'testnet4');
    const to = keyring.btcAddress(1, 'p2wpkh', 'testnet4');

    // Create a UTXO with the wrong scriptPubKey (from other address)
    const badUtxo: BtcUtxo = {
      txid: '11'.repeat(32),
      vout: 0,
      value: 100_000n,
      scriptPubKey: scriptPubKeyHex(other), // Wrong! Should match 'from'
      confirmations: 6,
    };

    const selection = selectCoins([badUtxo], 50_000n, 2, 'p2wpkh');

    expect(() =>
      buildPsbt({
        network: net,
        addressType: 'p2wpkh',
        from,
        to,
        changeAddress: from,
        amount: 50_000n,
        selection,
      }),
    ).toThrow('A selected UTXO does not pay the sending address');
  });

  it('rejects a UTXO with empty scriptPubKey during PSBT building', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const to = keyring.btcAddress(1, 'p2wpkh', 'testnet4');

    // Create a UTXO with an empty scriptPubKey
    const badUtxo: BtcUtxo = {
      txid: '11'.repeat(32),
      vout: 0,
      value: 100_000n,
      scriptPubKey: '', // Empty!
      confirmations: 6,
    };

    const selection = selectCoins([badUtxo], 50_000n, 2, 'p2wpkh');

    expect(() =>
      buildPsbt({
        network: net,
        addressType: 'p2wpkh',
        from,
        to,
        changeAddress: from,
        amount: 50_000n,
        selection,
      }),
    ).toThrow('A selected UTXO does not pay the sending address');
  });

  it('accepts a P2TR UTXO with correct scriptPubKey', async () => {
    const net = network('btc-testnet4');
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2tr', 'testnet4');
    const to = keyring.btcAddress(1, 'p2tr', 'testnet4');

    // Create a UTXO with correct P2TR scriptPubKey
    const correctUtxo: BtcUtxo = {
      txid: '11'.repeat(32),
      vout: 0,
      value: 100_000n,
      scriptPubKey: scriptPubKeyHex(from),
      confirmations: 6,
    };

    const selection = selectCoins([correctUtxo], 50_000n, 2, 'p2tr');

    // Should not throw
    const unsigned = buildPsbt({
      network: net,
      addressType: 'p2tr',
      from,
      to,
      changeAddress: from,
      amount: 50_000n,
      selection,
    });

    expect(unsigned.inputCount).toBe(1);
  });
});

describe('BitcoinAdapter', () => {
  const net = network('btc-testnet4');

  function dataSource(address: string, overrides: Partial<BitcoinDataSource> = {}): BitcoinDataSource {
    return {
      chain: 'testnet4',
      getTipHeight: async () => 100n,
      getUtxos: async () => [utxo(address, 100_000n)],
      getFees: async () => ({ low: 1, market: 2, aggressive: 5, tipHeight: 100, quotedAt: Date.now() }),
      getTransaction: async () => null,
      getHistory: async () => ({ items: [] }),
      broadcast: async () => '22'.repeat(32),
      ...overrides,
    };
  }

  async function setup(overrides: Partial<BitcoinDataSource> = {}) {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const from = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    const to = keyring.btcAddress(1, 'p2wpkh', 'testnet4');
    const adapter = new BitcoinAdapter({
      network: net,
      dataSource: dataSource(from, overrides),
      now: () => 1,
    });
    return { adapter, from, to };
  }

  it('quotes three fee tiers and builds a PSBT', async () => {
    const { adapter, from, to } = await setup();
    const asset = adapter.listAssets()[0]!;
    const quote = await adapter.estimateFee({ from, to, asset, amount: 50_000n });
    expect(Object.keys(quote.options)).toEqual(['low', 'market', 'aggressive']);
    expect(quote.options.market.params.feeRate).toBe(2);
    expect(quote.options.aggressive.maxFee).toBeGreaterThan(quote.options.low.maxFee);

    const unsigned = await adapter.buildTransaction({ from, to, asset, amount: 50_000n }, quote.options.market);
    expect(adapter.describe(unsigned).amount).toBe(50_000n);
  });

  it('reports the tip as the chain height', async () => {
    const { adapter } = await setup();
    expect(await adapter.getChainStatus()).toEqual({ blockNumber: 100n });
  });
});
