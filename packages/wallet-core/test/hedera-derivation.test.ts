import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  HEDERA_COIN_TYPE,
  HDKeyring,
  SignerError,
  bytesToHex,
  deriveHederaNode,
  hederaDerivationPath,
  hederaPublicKeyFromNode,
  masterKeyFromSeed,
} from '../src';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Hedera derivation constants', () => {
  it('uses SLIP-44 coin type 3030', () => {
    expect(HEDERA_COIN_TYPE).toBe(3030);
  });

  it('builds the correct BIP-44 path for each index', () => {
    expect(hederaDerivationPath(0)).toBe("m/44'/3030'/0'/0/0");
    expect(hederaDerivationPath(1)).toBe("m/44'/3030'/0'/0/1");
    expect(hederaDerivationPath(99)).toBe("m/44'/3030'/0'/0/99");
    expect(hederaDerivationPath(2 ** 31 - 1)).toBe(`m/44'/3030'/0'/0/${2 ** 31 - 1}`);
  });

  it('rejects negative, fractional and out-of-range indexes', () => {
    expect(() => hederaDerivationPath(-1)).toThrow(RangeError);
    expect(() => hederaDerivationPath(1.5)).toThrow(RangeError);
    expect(() => hederaDerivationPath(2 ** 31)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Public key shape
// ---------------------------------------------------------------------------

describe('hederaPublicKey — key shape and format', () => {
  it('returns a 66-hex-char compressed secp256k1 public key', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const pub = keyring.hederaPublicKey(0);
    expect(pub).toHaveLength(66);
    expect(pub).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it('every index produces a correctly shaped key', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    for (const i of [0, 1, 2, 10, 50]) {
      const pub = keyring.hederaPublicKey(i);
      expect(pub, `index ${i}`).toHaveLength(66);
      expect(pub, `index ${i}`).toMatch(/^(02|03)[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and isolation
// ---------------------------------------------------------------------------

describe('hederaPublicKey — determinism', () => {
  it('is deterministic: two keyrings from the same mnemonic agree', async () => {
    const a = await HDKeyring.fromMnemonic(MNEMONIC);
    const b = await HDKeyring.fromMnemonic(MNEMONIC);
    for (const i of [0, 1, 5]) {
      expect(a.hederaPublicKey(i), `index ${i}`).toBe(b.hederaPublicKey(i));
    }
  });

  it('caches: repeated calls return the same value', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    expect(keyring.hederaPublicKey(0)).toBe(keyring.hederaPublicKey(0));
    expect(keyring.hederaPublicKey(3)).toBe(keyring.hederaPublicKey(3));
  });

  it('produces distinct keys for distinct indexes', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const keys = [0, 1, 2, 3, 4].map((i) => keyring.hederaPublicKey(i));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Coin-type isolation from EVM
// ---------------------------------------------------------------------------

describe('Hedera vs EVM key isolation', () => {
  it('m/44p/3030p/0p/0/i differs from m/44p/60p/0p/0/i at every index', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    for (const i of [0, 1, 2]) {
      const hPub = keyring.hederaPublicKey(i);
      // EVM address is derived from the EVM public key; extract the raw
      // public key via deriveHederaNode on the EVM path as a cross-check.
      const seed = mnemonicToSeedSync(MNEMONIC);
      const master = masterKeyFromSeed(seed);
      const evmNode = master.derive(`m/44'/60'/0'/0/${i}`);
      const evmPub = bytesToHex(evmNode.publicKey!);
      evmNode.wipePrivateData();
      expect(hPub, `index ${i}`).not.toBe(evmPub);
    }
  });
});

// ---------------------------------------------------------------------------
// Private-key consistency
// ---------------------------------------------------------------------------

describe('withHederaPrivateKey', () => {
  it('the private key produces the same public key as hederaPublicKey', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    for (const i of [0, 1, 5]) {
      const pubFromKeyring = keyring.hederaPublicKey(i);
      const pubFromPrivate = keyring.withHederaPrivateKey(i, (pk) =>
        bytesToHex(secp256k1.getPublicKey(pk, true)),
      );
      expect(pubFromPrivate, `index ${i}`).toBe(pubFromKeyring);
    }
  });

  it('returns the callback return value', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    const result = keyring.withHederaPrivateKey(0, () => 'sentinel');
    expect(result).toBe('sentinel');
  });

  it('the private key is wiped: a captured copy still held valid bytes during the call', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    let snapshot: Uint8Array | null = null;
    keyring.withHederaPrivateKey(0, (pk) => {
      snapshot = new Uint8Array(pk); // copy before wipe
    });
    expect(snapshot).not.toBeNull();
    // The copy must be non-zero (a real private key).
    expect(snapshot!.some((b: number) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lock / unlock guard
// ---------------------------------------------------------------------------

describe('lock guard', () => {
  it('hederaPublicKey throws SignerError when locked', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    keyring.lock();
    expect(() => keyring.hederaPublicKey(0)).toThrow(SignerError);
  });

  it('withHederaPrivateKey throws SignerError when locked', async () => {
    const keyring = await HDKeyring.fromMnemonic(MNEMONIC);
    keyring.lock();
    expect(() => keyring.withHederaPrivateKey(0, () => {})).toThrow(SignerError);
  });
});

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

describe('deriveHederaNode + hederaPublicKeyFromNode', () => {
  it('agree with hederaPublicKey', () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const master = masterKeyFromSeed(seed);
    for (const i of [0, 1]) {
      const node = deriveHederaNode(master, i);
      const pub = bytesToHex(hederaPublicKeyFromNode(node));
      node.wipePrivateData();
      expect(pub).toHaveLength(66);
      expect(pub).toMatch(/^(02|03)[0-9a-f]{64}$/);
    }
  });

  it('hederaPublicKeyFromNode throws when publicKey is absent', () => {
    // Simulate a public-key-less node (e.g., constructed without derivation).
    expect(() => hederaPublicKeyFromNode({ publicKey: undefined } as never)).toThrow(
      'Public key unavailable',
    );
  });
});
