import { describe, expect, it } from 'vitest';
import contract from '../../../docs/api/networks.json';
import { EVM_NETWORKS } from '../src/networks';

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
