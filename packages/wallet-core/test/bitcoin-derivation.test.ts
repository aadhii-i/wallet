import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import {
  HDKeyring,
  btcDerivationPath,
  bitcoinCoinType,
  bitcoinHrp,
  bytesToHex,
  decodeBitcoinAddress,
  deriveBtcNode,
  isValidBitcoinAddress,
  masterKeyFromSeed,
  taprootOutputKey,
  taprootTweakPrivateKey,
} from '../src';

/** BIP-39 test vector mnemonic used by the BIP-84 and BIP-86 test pages. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Bitcoin derivation metadata', () => {
  it('builds BIP-84 and BIP-86 paths with the right coin type', () => {
    expect(btcDerivationPath(0, 'p2wpkh', 'mainnet')).toBe("m/84'/0'/0'/0/0");
    expect(btcDerivationPath(7, 'p2wpkh', 'testnet4')).toBe("m/84'/1'/0'/0/7");
    expect(btcDerivationPath(0, 'p2tr', 'mainnet')).toBe("m/86'/0'/0'/0/0");
    expect(btcDerivationPath(3, 'p2tr', 'testnet4')).toBe("m/86'/1'/0'/0/3");
    expect(bitcoinCoinType('mainnet')).toBe(0);
    expect(bitcoinCoinType('testnet4')).toBe(1);
    expect(bitcoinHrp('mainnet')).toBe('bc');
    expect(bitcoinHrp('testnet4')).toBe('tb');
  });

  it('rejects an invalid index', () => {
    expect(() => btcDerivationPath(-1)).toThrow(RangeError);
    expect(() => btcDerivationPath(1.5)).toThrow(RangeError);
  });
});

describe('BIP-84 P2WPKH addresses', () => {
  it('matches the BIP-84 test vectors', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    expect(keyring.btcAddress(0, 'p2wpkh', 'mainnet')).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(keyring.btcAddress(1, 'p2wpkh', 'mainnet')).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
  });

  it('uses the testnet4 hrp for testnet4', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const addr = keyring.btcAddress(0, 'p2wpkh', 'testnet4');
    expect(addr.startsWith('tb1q')).toBe(true);
    const decoded = decodeBitcoinAddress(addr);
    expect(decoded.hrp).toBe('tb');
    expect(decoded.type).toBe('p2wpkh');
    expect(decoded.program).toHaveLength(20);
  });

  it('is deterministic across keyring instances', async () => {
    const a = await HDKeyring.fromMnemonic(MNEMONIC);
    const b = await HDKeyring.fromMnemonic(MNEMONIC);
    expect(a.btcAddress(2, 'p2wpkh', 'mainnet')).toBe(b.btcAddress(2, 'p2wpkh', 'mainnet'));
  });
});

describe('BIP-86 P2TR addresses', () => {
  it('matches the BIP-86 test vectors', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    expect(keyring.btcAddress(0, 'p2tr', 'mainnet')).toBe(
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    );
  });

  it('derives the tweaked signing key whose public key is the output key', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const decoded = decodeBitcoinAddress(keyring.btcAddress(0, 'p2tr', 'mainnet'));
    expect(decoded.type).toBe('p2tr');
    expect(decoded.program).toHaveLength(32);
    const output = keyring.withBtcPrivateKey(0, 'p2tr', 'mainnet', (pk) => {
      const tweaked = taprootTweakPrivateKey(pk, secp256k1.getPublicKey(pk, true));
      return schnorr.getPublicKey(tweaked);
    });
    expect(bytesToHex(output)).toBe(bytesToHex(decoded.program));
  });

  it('tags the testnet4 address with tb1p', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const addr = keyring.btcAddress(0, 'p2tr', 'testnet4');
    expect(addr.startsWith('tb1p')).toBe(true);
    expect(decodeBitcoinAddress(addr).hrp).toBe('tb');
  });

  it('tweaks the internal public key into the address witness program', async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const node = deriveBtcNode(masterKeyFromSeed(seed), 0, 'p2tr', 'mainnet');
    const decoded = decodeBitcoinAddress(
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    );
    expect(bytesToHex(taprootOutputKey(node.publicKey!))).toBe(bytesToHex(decoded.program));
  });
});

describe('Bitcoin address validation', () => {
  it('rejects cross-network addresses', () => {
    const mainnet = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    expect(isValidBitcoinAddress(mainnet, 'mainnet')).toBe(true);
    expect(isValidBitcoinAddress(mainnet, 'testnet4')).toBe(false);
  });

  it('rejects mixed case and bad checksums', () => {
    expect(isValidBitcoinAddress('BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU', 'mainnet')).toBe(false);
    expect(isValidBitcoinAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv', 'mainnet')).toBe(false);
  });

  it('rejects unsupported witness versions and program lengths', () => {
    // Valid BIP-350 addresses, but not types this wallet creates.
    expect(isValidBitcoinAddress('bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'mainnet')).toBe(false);
    expect(isValidBitcoinAddress('bc1sw50qgdz25j', 'mainnet')).toBe(false);
  });

  it('rejects unknown human-readable parts', () => {
    expect(() => decodeBitcoinAddress('ltc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toThrow();
  });
});
