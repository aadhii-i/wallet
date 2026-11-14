import { describe, expect, it } from 'vitest';
import contract from '../../../docs/api/networks.json';
import { BITCOIN_NETWORKS, EVM_NETWORKS, HEDERA_NETWORKS } from '../src/networks';

/**
 * docs/api/networks.json is the cross-language contract for the fields both the
 * client registry and wallet-api's staticMetadata declare. The Go test
 * internal/blockchain/evm/network_test.go asserts the server half; this asserts
 * the client half, so a chain added on one side alone fails `pnpm test`.
 *
 * Client-only presentation fields (explorer, accent, feeModel, blockTimeMs,
 * confirmationsForFinal, feeWarningNative, faucetUrl, shortName) are deliberately
 * not part of the contract.
 */
interface ContractNetwork {
  id: string;
  chainId: number;
  name: string;
  kind: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

const networks = contract.networks as ContractNetwork[];

describe('client network registry matches the cross-language contract', () => {
  it('declares exactly the contract chain ids', () => {
    expect(EVM_NETWORKS.map((n) => n.chainId).sort((a, b) => a - b)).toEqual(
      networks.map((n) => n.chainId).sort((a, b) => a - b),
    );
  });

  it('agrees with the contract on every shared field', () => {
    for (const want of networks) {
      const got = EVM_NETWORKS.find((n) => n.chainId === want.chainId);
      if (!got) {
        throw new Error(`client registry is missing chain id ${want.chainId}`);
      }
      expect([got.id, got.name, got.kind, got.nativeCurrency.symbol, got.nativeCurrency.decimals], `chain ${want.chainId}`).toEqual([
        want.id,
        want.name,
        want.kind,
        want.nativeSymbol,
        want.nativeDecimals,
      ]);
    }
  });

  it('never declares the backend-only unknown kind', () => {
    expect(EVM_NETWORKS.every((n) => n.kind !== 'unknown')).toBe(true);
  });

  it('keeps chain ids unique', () => {
    const ids = EVM_NETWORKS.map((n) => n.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

interface ContractBitcoinNetwork {
  id: string;
  chain: string;
  name: string;
  kind: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

const bitcoinNetworks = (contract as { bitcoinNetworks: ContractBitcoinNetwork[] }).bitcoinNetworks;

/**
 * Bitcoin networks have no chain id, so they live in their own section of the
 * contract. The Go Bitcoin registry asserts the same list.
 */
describe('client Bitcoin registry matches the cross-language contract', () => {
  it('declares exactly the contract networks', () => {
    expect(BITCOIN_NETWORKS.map((n) => n.id).sort()).toEqual(bitcoinNetworks.map((n) => n.id).sort());
  });

  it('agrees with the contract on every shared field', () => {
    for (const want of bitcoinNetworks) {
      const got = BITCOIN_NETWORKS.find((n) => n.id === want.id);
      if (!got) throw new Error(`client registry is missing Bitcoin network ${want.id}`);
      expect(
        [got.name, got.kind, got.nativeCurrency.symbol, got.nativeCurrency.decimals, got.bitcoin.chain],
        want.id,
      ).toEqual([want.name, want.kind, want.nativeSymbol, want.nativeDecimals, want.chain]);
    }
  });

  it('uses the coin type and hrp of the chain it declares', () => {
    for (const n of BITCOIN_NETWORKS) {
      expect(n.bitcoin.coinType).toBe(n.bitcoin.chain === 'mainnet' ? 0 : 1);
      expect(n.bitcoin.bech32Hrp).toBe(n.bitcoin.chain === 'mainnet' ? 'bc' : 'tb');
      // P2WPKH is the default: it hides the public key until the output is spent.
      expect(n.bitcoin.defaultAddressType).toBe('p2wpkh');
    }
  });
});

interface ContractHederaNetwork {
  id: string;
  chain: string;
  name: string;
  kind: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

const hederaNetworks = (contract as { hederaNetworks: ContractHederaNetwork[] }).hederaNetworks;

describe('client Hedera registry matches the cross-language contract', () => {
  it('declares exactly the contract networks', () => {
    expect(HEDERA_NETWORKS.map((n) => n.id).sort()).toEqual(
      hederaNetworks.map((n) => n.id).sort(),
    );
  });

  it('agrees with the contract on every shared field', () => {
    for (const want of hederaNetworks) {
      const got = HEDERA_NETWORKS.find((n) => n.id === want.id);
      if (!got) throw new Error(`client registry is missing Hedera network ${want.id}`);
      expect(
        [got.name, got.kind, got.nativeCurrency.symbol, got.nativeCurrency.decimals, got.hedera.chain],
        want.id,
      ).toEqual([want.name, want.kind, want.nativeSymbol, want.nativeDecimals, want.chain]);
    }
  });

  it('uses the correct SLIP-44 coin type', () => {
    for (const n of HEDERA_NETWORKS) {
      expect(n.hedera.coinType).toBe(3030);
    }
  });

  it('uses HTTPS mirror node URLs', () => {
    for (const n of HEDERA_NETWORKS) {
      expect(n.hedera.mirrorNodeUrl).toMatch(/^https:\/\//);
    }
  });
});
