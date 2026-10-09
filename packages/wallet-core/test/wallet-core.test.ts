import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { mnemonicToAccount } from 'viem/accounts';
import {
  keccak256,
  parseEther,
  parseGwei,
  recoverMessageAddress,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import {
  ConfirmationRegistry,
  HDKeyring,
  HDSigner,
  SignerError,
  VaultError,
  bytesToHex,
  checkPasswordStrength,
  decryptVault,
  encryptVault,
  evmDerivationPath,
  fromBase64Url,
  fromHex,
  generateMnemonic,
  hashPayload,
  isValidEvmChecksum,
  normalizeMnemonic,
  pickVerificationIndexes,
  readTypedTxChainId,
  suggestWords,
  toBase64Url,
  toChecksumAddress,
  validateMnemonic,
  type SigningPayload,
} from '../src';

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FAST_KDF = { kdf: { m: 64, t: 1, p: 1 }, allowWeakKdfForTests: true } as const;

describe('mnemonic', () => {
  it('matches the official Trezor BIP-39 vector', () => {
    const seed = mnemonicToSeedSync(ABANDON, 'TREZOR');
    expect(bytesToHex(seed)).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('generates valid 12- and 24-word phrases', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(12);
    expect(generateMnemonic(256).split(' ')).toHaveLength(24);
    expect(validateMnemonic(generateMnemonic())).toEqual({ ok: true, words: 12 });
  });

  it('never generates the same phrase twice', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateMnemonic()));
    expect(set.size).toBe(50);
  });

  it('reports word count, unknown words and checksum errors', () => {
    expect(validateMnemonic('abandon abandon')).toEqual({ ok: false, reason: 'word_count' });
    expect(validateMnemonic(ABANDON.replace('about', 'aboutt'))).toEqual({
      ok: false,
      reason: 'unknown_words',
      unknownIndexes: [11],
    });
    expect(validateMnemonic(ABANDON.replace('about', 'abandon'))).toEqual({ ok: false, reason: 'checksum' });
  });

  it('normalizes whitespace and case', () => {
    expect(normalizeMnemonic(`  ${ABANDON.toUpperCase().replace(/ /g, '   \n')} `)).toBe(ABANDON);
    expect(validateMnemonic(ABANDON.toUpperCase()).ok).toBe(true);
  });

  it('suggests words by prefix', () => {
    expect(suggestWords('aban')).toEqual(['abandon']);
    expect(suggestWords('')).toEqual([]);
    expect(suggestWords('ab', 2)).toHaveLength(2);
  });

  it('picks distinct sorted verification indexes', () => {
    for (let i = 0; i < 20; i++) {
      const idx = pickVerificationIndexes(12, 3);
      expect(new Set(idx).size).toBe(3);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(idx.every((n) => n >= 0 && n < 12)).toBe(true);
    }
  });
});

describe('derivation', () => {
  it('matches BIP-32 test vector 1', () => {
    const master = HDKey.fromMasterSeed(fromHex('000102030405060708090a0b0c0d0e0f'));
    expect(master.privateExtendedKey).toBe(
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    );
  });

  it('uses the MetaMask-compatible path', () => {
    expect(evmDerivationPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(evmDerivationPath(7)).toBe("m/44'/60'/0'/0/7");
    expect(() => evmDerivationPath(-1)).toThrow(RangeError);
    expect(() => evmDerivationPath(1.5)).toThrow(RangeError);
    expect(() => evmDerivationPath(2 ** 31)).toThrow(RangeError);
  });

  it('derives the well-known Anvil/Hardhat accounts', async () => {
    const kr = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    expect(kr.evmAddress(0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(kr.evmAddress(1)).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(kr.evmAddress(2)).toBe('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
  });

  it('agrees with viem for random phrases and indexes', async () => {
    for (let i = 0; i < 3; i++) {
      const phrase = generateMnemonic();
      const kr = await HDKeyring.fromMnemonic(phrase);
      for (const index of [0, 1, 42]) {
        expect(kr.evmAddress(index)).toBe(mnemonicToAccount(phrase, { addressIndex: index }).address);
      }
    }
  });

  it('computes and validates EIP-55 checksums', () => {
    const vectors = [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ];
    for (const v of vectors) {
      expect(toChecksumAddress(v.toLowerCase())).toBe(v);
      expect(isValidEvmChecksum(v)).toBe(true);
      expect(isValidEvmChecksum(v.toLowerCase())).toBe(true);
    }
    // flip the case of one letter → invalid checksum
    const bad = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(isValidEvmChecksum(bad)).toBe(false);
    expect(isValidEvmChecksum('0x123')).toBe(false);
  });

  it('refuses to derive after lock', async () => {
    const kr = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    kr.lock();
    expect(kr.locked).toBe(true);
    expect(() => kr.evmAddress(0)).toThrow(SignerError);
  });

  it('rejects invalid phrases', async () => {
    await expect(HDKeyring.fromMnemonic('not a phrase')).rejects.toThrow();
  });
});

describe('vault', () => {
  const contents = { mnemonic: ABANDON, createdAt: '2026-01-01T00:00:00.000Z', backedUp: false };

  it('round-trips with the correct password', async () => {
    const vault = await encryptVault(contents, 'correct horse 9!', FAST_KDF);
    expect(JSON.stringify(vault)).not.toContain('abandon');
    await expect(decryptVault(vault, 'correct horse 9!', FAST_KDF)).resolves.toEqual(contents);
  });

  it('uses unique salt and IV per encryption', async () => {
    const a = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    const b = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects a wrong password', async () => {
    const vault = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    await expect(decryptVault(vault, 'pw-12345679', FAST_KDF)).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
  });

  it('detects ciphertext tampering', async () => {
    const vault = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    const ct = fromBase64Url(vault.ct);
    ct[5] = ct[5]! ^ 0x01;
    await expect(decryptVault({ ...vault, ct: toBase64Url(ct) }, 'pw-12345678', FAST_KDF)).rejects.toBeInstanceOf(
      VaultError,
    );
  });

  it('binds the KDF header via AAD', async () => {
    const vault = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    const altered = { ...vault, kdf: { ...vault.kdf, t: 2 } };
    await expect(decryptVault(altered, 'pw-12345678', FAST_KDF)).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
  });

  it('refuses weak KDF parameters outside tests', async () => {
    const vault = await encryptVault(contents, 'pw-12345678', FAST_KDF);
    await expect(decryptVault(vault, 'pw-12345678')).rejects.toMatchObject({ code: 'WEAK_PARAMS' });
    await expect(encryptVault(contents, 'pw', { kdf: { m: 1024, t: 1, p: 1 } })).rejects.toMatchObject({
      code: 'WEAK_PARAMS',
    });
  });

  it('rejects unknown formats', async () => {
    await expect(decryptVault({ v: 2 } as never, 'x')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('works with production KDF parameters', async () => {
    const vault = await encryptVault(contents, 'pw-12345678');
    expect(vault.kdf).toMatchObject({ alg: 'argon2id', m: 65536, t: 2, p: 1 });
    await expect(decryptVault(vault, 'pw-12345678')).resolves.toEqual(contents);
  }, 30_000);

  it('grades password strength', () => {
    expect(checkPasswordStrength('short').ok).toBe(false);
    expect(checkPasswordStrength('alllowercase').ok).toBe(false);
    expect(checkPasswordStrength('Lower-and-9').ok).toBe(true);
  });
});

describe('HDSigner', () => {
  const tx: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: 11155111,
    nonce: 3,
    to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    value: parseEther('0.0123'),
    gas: 21000n,
    maxFeePerGas: parseGwei('30'),
    maxPriorityFeePerGas: parseGwei('1.5'),
  };

  async function setup() {
    const keyring = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    const signer = new HDSigner(keyring);
    const from = keyring.evmAddress(0);
    const payload: SigningPayload = {
      kind: 'evm-transaction',
      chainId: tx.chainId,
      from,
      serializedUnsigned: serializeTransaction(tx),
    };
    return { keyring, signer, from, payload, account: { id: 'acc-0', hdIndex: 0 } };
  }

  it('produces signatures identical to viem (RFC 6979) and recoverable to the sender', async () => {
    const { signer, from, payload, account } = await setup();
    const token = signer.confirmations.issue(payload);
    const sig = await signer.sign({ account, payload, confirmation: token });
    expect(sig.kind).toBe('evm-ecdsa');
    if (sig.kind !== 'evm-ecdsa') return;
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.yParity });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(from);

    const viemSigned = await mnemonicToAccount(ANVIL_MNEMONIC).signTransaction(tx);
    expect(signed).toBe(viemSigned);
  });

  it('signs EIP-191 personal messages', async () => {
    const { signer, from, account } = await setup();
    const payload: SigningPayload = { kind: 'evm-personal-message', from, message: '0x68656c6c6f' };
    const sig = await signer.sign({ account, payload, confirmation: signer.confirmations.issue(payload) });
    if (sig.kind !== 'evm-personal') throw new Error('wrong kind');
    expect(await recoverMessageAddress({ message: 'hello', signature: sig.signature })).toBe(from);
    expect(sig.signature).toBe(await mnemonicToAccount(ANVIL_MNEMONIC).signMessage({ message: 'hello' }));
  });

  it('refuses to sign without a confirmation token', async () => {
    const { signer, payload, account } = await setup();
    await expect(signer.sign({ account, payload, confirmation: undefined as never })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISSING',
    });
  });

  it('refuses a payload that changed after review (recipient swap)', async () => {
    const { signer, payload, account } = await setup();
    const token = signer.confirmations.issue(payload);
    const swapped: SigningPayload = {
      ...payload,
      serializedUnsigned: serializeTransaction({ ...tx, to: '0x000000000000000000000000000000000000dEaD' }),
    } as SigningPayload;
    await expect(signer.sign({ account, payload: swapped, confirmation: token })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    });
  });

  it('refuses token reuse (replay)', async () => {
    const { signer, payload, account } = await setup();
    const token = signer.confirmations.issue(payload);
    await signer.sign({ account, payload, confirmation: token });
    await expect(signer.sign({ account, payload, confirmation: token })).rejects.toMatchObject({
      code: 'CONFIRMATION_REUSED',
    });
  });

  it('refuses a forged token', async () => {
    const { signer, payload, account } = await setup();
    const forged = { id: 'deadbeef', payloadHash: hashPayload(payload), issuedAt: Date.now() };
    await expect(signer.sign({ account, payload, confirmation: forged })).rejects.toMatchObject({
      code: 'CONFIRMATION_MISMATCH',
    });
  });

  it('refuses expired tokens', async () => {
    let now = 1_000_000;
    const keyring = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    const signer = new HDSigner(keyring, new ConfirmationRegistry(() => now));
    const payload: SigningPayload = {
      kind: 'evm-transaction',
      chainId: 1,
      from: keyring.evmAddress(0),
      serializedUnsigned: serializeTransaction(tx),
    };
    const token = signer.confirmations.issue(payload);
    now += 6 * 60 * 1000;
    await expect(signer.sign({ account: { id: 'a', hdIndex: 0 }, payload, confirmation: token })).rejects.toMatchObject(
      { code: 'CONFIRMATION_EXPIRED' },
    );
  });

  it('refuses when the payload sender is a different account', async () => {
    const { signer, payload } = await setup();
    const token = signer.confirmations.issue(payload);
    await expect(
      signer.sign({ account: { id: 'acc-1', hdIndex: 1 }, payload, confirmation: token }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  });

  it('refuses untyped (legacy, no chain id) transactions', async () => {
    const { signer, from, account } = await setup();
    const legacy = serializeTransaction({ to: tx.to!, value: 1n, gas: 21000n, gasPrice: 1n, nonce: 0 });
    const payload: SigningPayload = { kind: 'evm-transaction', chainId: 1, from, serializedUnsigned: legacy };
    await expect(
      signer.sign({ account, payload, confirmation: signer.confirmations.issue(payload) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('refuses to sign when locked', async () => {
    const { keyring, signer, payload, account } = await setup();
    const token = signer.confirmations.issue(payload);
    keyring.lock();
    await expect(signer.sign({ account, payload, confirmation: token })).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('hashes payloads canonically', () => {
    const p: SigningPayload = { kind: 'evm-personal-message', from: '0xABCDEF0000000000000000000000000000000000', message: '0xAA' };
    expect(hashPayload(p)).toBe(hashPayload({ ...p, from: p.from.toLowerCase() as never, message: '0xaa' }));
    expect(keccak256('0x00')).toMatch(/^0x/);
  });
});

describe('audit hardening', () => {
  it('rejects a payload whose signed chain id differs from the declared one', async () => {
    const keyring = await HDKeyring.fromMnemonic(ANVIL_MNEMONIC);
    const signer = new HDSigner(keyring);
    const serializedUnsigned = serializeTransaction({ type: 'eip1559', chainId: 1, nonce: 0, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const payload: SigningPayload = { kind: 'evm-transaction', chainId: 11155111, from: keyring.evmAddress(0), serializedUnsigned };
    await expect(signer.sign({ account: { id: 'a', hdIndex: 0 }, payload, confirmation: signer.confirmations.issue(payload) })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('reads chain ids of any size', () => {
    for (const chainId of [1, 137, 8453, 31337, 11155111]) {
      const s = serializeTransaction({ type: 'eip1559', chainId, nonce: 0, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      expect(readTypedTxChainId(fromHex(s))).toBe(BigInt(chainId));
    }
  });

  it('refuses vault headers with absurd KDF cost', async () => {
    const vault = await encryptVault({ mnemonic: ABANDON, createdAt: 'x', backedUp: true }, 'pw-12345678', FAST_KDF);
    await expect(decryptVault({ ...vault, kdf: { ...vault.kdf, m: 2 ** 30 } }, 'pw-12345678', FAST_KDF)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
