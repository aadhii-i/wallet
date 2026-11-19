import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import {
  HDKeyring,
  btcAccountPath,
  bitcoinAddressFromPublicKey,
  btcAccountDescriptor,
  masterKeyFromSeed,
} from '../src';
import { mnemonicToSeedSync } from '@scure/bip39';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** BIP-32 version bytes for testnet (`tpub`). */
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

/** Pulls the extended public key out of a descriptor. */
function xpubOf(descriptor: string): string {
  const match = /\(([^)]*)\)$/.exec(descriptor);
  if (!match) throw new Error(`Malformed descriptor: ${descriptor}`);
  // Strip the key origin `[fingerprint/path]` and the trailing `/0/*`.
  const body = match[1]!.replace(/^\[[^\]]*\]/, '').replace(/\/0\/\*$/, '');
  return body;
}

function descriptorAddress(
  descriptor: string,
  index: number,
  addressType: 'p2wpkh' | 'p2tr',
  network: 'mainnet' | 'testnet4',
): string {
  const versions = network === 'mainnet' ? undefined : TESTNET_VERSIONS;
  const node = HDKey.fromExtendedKey(xpubOf(descriptor), versions).derive(`m/0/${index}`);
  return bitcoinAddressFromPublicKey(node.publicKey!, addressType, network);
}

describe('Bitcoin account descriptor', () => {
  it('derives the same addresses as the wallet itself (BIP-84)', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const { descriptor } = keyring.btcDescriptor('p2wpkh', 'mainnet');
    expect(descriptor).toMatch(/^wpkh\(\[[0-9a-f]{8}\/84'\/0'\/0'\]xpub[0-9A-Za-z]+\/0\/\*\)$/);
    for (const index of [0, 1, 7]) {
      expect(descriptorAddress(descriptor, index, 'p2wpkh', 'mainnet')).toBe(
        keyring.btcAddress(index, 'p2wpkh', 'mainnet'),
      );
    }
  });

  it('derives the same addresses as the wallet itself (BIP-86)', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const { descriptor } = keyring.btcDescriptor('p2tr', 'mainnet');
    expect(descriptor).toMatch(/^tr\(\[[0-9a-f]{8}\/86'\/0'\/0'\]xpub[0-9A-Za-z]+\/0\/\*\)$/);
    expect(descriptorAddress(descriptor, 0, 'p2tr', 'mainnet')).toBe(
      keyring.btcAddress(0, 'p2tr', 'mainnet'),
    );
  });

  it('uses the testnet key origin and key version on testnet4', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const { descriptor, xpub } = keyring.btcDescriptor('p2wpkh', 'testnet4');
    expect(descriptor).toContain("/84'/1'/0'");
    expect(xpub.startsWith('tpub')).toBe(true);
    expect(descriptorAddress(descriptor, 0, 'p2wpkh', 'testnet4')).toBe(
      keyring.btcAddress(0, 'p2wpkh', 'testnet4'),
    );
  });

  it('never exposes private key material', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const { descriptor, xpub } = keyring.btcDescriptor('p2wpkh', 'mainnet');
    expect(descriptor).not.toMatch(/xprv|tprv|private/i);
    expect(xpub).not.toMatch(/xprv|tprv/);
  });

  it('exposes the account path it is derived from', () => {
    expect(btcAccountPath('p2wpkh', 'mainnet')).toBe("m/84'/0'/0'");
    expect(btcAccountPath('p2tr', 'testnet4')).toBe("m/86'/1'/0'");
  });

  it('is stable for the same seed', async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const a = btcAccountDescriptor(masterKeyFromSeed(seed), 'p2wpkh', 'mainnet');
    const b = btcAccountDescriptor(masterKeyFromSeed(seed), 'p2wpkh', 'mainnet');
    expect(a.descriptor).toBe(b.descriptor);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
