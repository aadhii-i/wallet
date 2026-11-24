import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiBtcUtxo } from '@qd/shared-types';
import { scriptPubKeyHex } from '@qd/bitcoin';
import { createBitcoinDataSource } from './bitcoin-api';

// Mock the API client
vi.mock('./api', () => ({
  getApi: vi.fn(async () => ({
    btcUtxos: vi.fn(async (_chain: string, _address: string) => ({
      utxos: mockUtxos,
    })),
    btcFees: vi.fn(async () => ({
      fees: {
        low: 1,
        market: 5,
        aggressive: 10,
        tipHeight: 160000,
        quotedAt: new Date().toISOString(),
      },
    })),
    btcTransaction: vi.fn(),
    btcHistory: vi.fn(),
    btcBroadcast: vi.fn(),
  })),
}));

let mockUtxos: ApiBtcUtxo[] = [];

describe('bitcoin-api', () => {
  beforeEach(() => {
    mockUtxos = [];
    vi.clearAllMocks();
  });

  describe('createBitcoinDataSource', () => {
    describe('getUtxos', () => {
      it('should add scriptPubKey for P2WPKH address', async () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        const expectedScriptPubKey = scriptPubKeyHex(address);

        mockUtxos = [
          {
            txid: '87f366e60fa3052531b21aea1ffc749b498be90e5684a2cd88f059ec56f0d2ac',
            vout: 1,
            value: '345872',
            scriptPubKey: '', // Backend returns empty
            confirmations: 1,
            blockHeight: 160773,
          },
          {
            txid: '0ded157c4958129d156c3a5f9d8ee34099f50b1ebd1745a13932ef3749165b5d',
            vout: 0,
            value: '2000',
            scriptPubKey: '', // Backend returns empty
            confirmations: 1,
            blockHeight: 160377,
          },
        ];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        expect(utxos).toHaveLength(2);
        expect(utxos[0]!.scriptPubKey).toBe(expectedScriptPubKey);
        expect(utxos[1]!.scriptPubKey).toBe(expectedScriptPubKey);
        expect(utxos[0]!.value).toBe(345872n);
        expect(utxos[1]!.value).toBe(2000n);
      });

      it('should add scriptPubKey for P2TR address', async () => {
        // P2TR testnet address (starts with tb1p)
        const address = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
        const expectedScriptPubKey = scriptPubKeyHex(address);

        mockUtxos = [
          {
            txid: 'abc123',
            vout: 0,
            value: '50000',
            scriptPubKey: '', // Backend returns empty
            confirmations: 6,
            blockHeight: 160500,
          },
        ];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        expect(utxos).toHaveLength(1);
        expect(utxos[0]!.scriptPubKey).toBe(expectedScriptPubKey);
        expect(utxos[0]!.scriptPubKey).toMatch(/^5120/); // P2TR starts with 0x51 0x20
        expect(utxos[0]!.value).toBe(50000n);
      });

      it('should handle empty UTXO list', async () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        mockUtxos = [];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        expect(utxos).toHaveLength(0);
      });

      it('should use the same scriptPubKey for all UTXOs from the same address', async () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        const expectedScriptPubKey = scriptPubKeyHex(address);

        mockUtxos = [
          { txid: 'tx1', vout: 0, value: '1000', scriptPubKey: '', confirmations: 1 },
          { txid: 'tx2', vout: 1, value: '2000', scriptPubKey: '', confirmations: 2 },
          { txid: 'tx3', vout: 0, value: '3000', scriptPubKey: '', confirmations: 3 },
        ];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        // All should have the exact same scriptPubKey reference
        expect(utxos.every(u => u.scriptPubKey === expectedScriptPubKey)).toBe(true);
      });

      it('should preserve blockHeight when present', async () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        mockUtxos = [
          {
            txid: 'tx1',
            vout: 0,
            value: '1000',
            scriptPubKey: '',
            confirmations: 5,
            blockHeight: 160000,
          },
        ];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        expect(utxos[0]!.blockHeight).toBe(160000);
      });

      it('should handle missing blockHeight', async () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        mockUtxos = [
          {
            txid: 'tx1',
            vout: 0,
            value: '1000',
            scriptPubKey: '',
            confirmations: 0,
          },
        ];

        const dataSource = createBitcoinDataSource('testnet4');
        const utxos = await dataSource.getUtxos(address);

        expect(utxos[0]!.blockHeight).toBeUndefined();
      });
    });

    describe('scriptPubKey validation', () => {
      it('should produce scriptPubKey that matches P2WPKH format', () => {
        const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
        const spk = scriptPubKeyHex(address);

        // P2WPKH: OP_0 (0x00) + push(20) (0x14) + 20-byte hash
        expect(spk).toMatch(/^0014[0-9a-f]{40}$/);
        expect(spk.length).toBe(44); // 2 + 2 + 40 hex chars
      });

      it('should produce scriptPubKey that matches P2TR format', () => {
        const address = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
        const spk = scriptPubKeyHex(address);

        // P2TR: OP_1 (0x51) + push(32) (0x20) + 32-byte x-only pubkey
        expect(spk).toMatch(/^5120[0-9a-f]{64}$/);
        expect(spk.length).toBe(68); // 2 + 2 + 64 hex chars
      });
    });

    describe('chainForNetworkId', () => {
      it('should map btc-mainnet to mainnet', async () => {
        const { chainForNetworkId } = await import('./bitcoin-api');
        expect(chainForNetworkId('btc-mainnet')).toBe('mainnet');
      });

      it('should map btc-testnet4 to testnet4', async () => {
        const { chainForNetworkId } = await import('./bitcoin-api');
        expect(chainForNetworkId('btc-testnet4')).toBe('testnet4');
      });

      it('should return undefined for unknown network', async () => {
        const { chainForNetworkId } = await import('./bitcoin-api');
        expect(chainForNetworkId('unknown')).toBeUndefined();
      });
    });
  });
});
