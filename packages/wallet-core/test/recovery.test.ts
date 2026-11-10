import { describe, expect, it } from 'vitest';
import { serializeTransaction } from 'viem';
import {
  ConfirmationRegistry,
  HDKeyring,
  HDSigner,
  VALID_WORD_COUNTS,
  evmDerivationPath,
  generateMnemonic,
  indexesToVerify,
  makeAccountMeta,
  nextAccountIndex,
  reconcileAccounts,
  validateMnemonic,
  type MnemonicStrength,
} from '../src';

// Public test vectors only — never a real user's phrase.
const HARDHAT = 'test test test test test test test test test test test junk';
const HARDHAT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const HARDHAT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const HARDHAT_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // MetaMask/BIP-44 reference address

describe('wallet recovery', () => {
  it('accepts every BIP-39 length (12/15/18/21/24 words)', () => {
    const strengths: Record<number, MnemonicStrength> = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
    for (const n of VALID_WORD_COUNTS) {
      const phrase = generateMnemonic(strengths[n]);
      expect(phrase.split(' ')).toHaveLength(n);
      expect(validateMnemonic(phrase)).toEqual({ ok: true, words: n });
    }
  });

  it('rejects a bad checksum and invalid lengths', () => {
    expect(validateMnemonic(ABANDON.replace(/about$/, 'abandon'))).toMatchObject({ ok: false, reason: 'checksum' });
    expect(validateMnemonic(`${ABANDON} abandon`)).toMatchObject({ ok: false, reason: 'word_count' }); // 13
    expect(validateMnemonic('abandon '.repeat(11).trim())).toMatchObject({ ok: false, reason: 'word_count' });
    expect(validateMnemonic('')).toMatchObject({ ok: false, reason: 'word_count' });
  });

  it('normalizes pasted whitespace and case before validating', () => {
    expect(validateMnemonic(`  ${HARDHAT.toUpperCase().replace(/ /g, '\n\t ')}  `).ok).toBe(true);
  });

  it('restores the known address for public test phrases on m/44\'/60\'/0\'/0/0', async () => {
    expect((await HDKeyring.fromMnemonic(HARDHAT)).evmAddress(0)).toBe(HARDHAT_0);
    expect((await HDKeyring.fromMnemonic(ABANDON)).evmAddress(0)).toBe(ABANDON_0);
    expect(evmDerivationPath(0)).toBe("m/44'/60'/0'/0/0");
  });

  it('restores the same addresses every time from the same phrase', async () => {
    const a = await HDKeyring.fromMnemonic(HARDHAT);
    const b = await HDKeyring.fromMnemonic(`  ${HARDHAT.toUpperCase()} `);
    expect([0, 1, 2, 7].map((i) => b.evmAddress(i))).toEqual([0, 1, 2, 7].map((i) => a.evmAddress(i)));
  });

  it('refuses an invalid phrase instead of creating a different wallet', async () => {
    await expect(HDKeyring.fromMnemonic(ABANDON.replace(/about$/, 'abandon'))).rejects.toThrow(/Invalid recovery phrase/);
  });

  it('does not put the phrase in the rejection error', async () => {
    const bad = HARDHAT.replace(/junk$/, 'test');
    const err = (await HDKeyring.fromMnemonic(bad).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('test test');
  });
});

describe('multiple HD accounts', () => {
  it('derives distinct, deterministic addresses per index on the documented path', async () => {
    const k = await HDKeyring.fromMnemonic(HARDHAT);
    expect([k.evmAddress(0), k.evmAddress(1), k.evmAddress(2)]).toEqual([HARDHAT_0, HARDHAT_1, HARDHAT_2]);
    expect(k.evmAddress(1)).toBe(k.evmAddress(1));
    expect(evmDerivationPath(1)).toBe("m/44'/60'/0'/0/1");
  });

  it('allocates the next index after the highest one, including hidden accounts', () => {
    expect(nextAccountIndex([])).toBe(0);
    expect(nextAccountIndex([{ index: 0 }, { index: 1 }])).toBe(2);
    expect(nextAccountIndex([{ index: 0 }, { index: 4 }])).toBe(5);
  });

  it('records public metadata only: index, path, address, name, creation time', () => {
    const m = makeAccountMeta(2, HARDHAT_2, undefined, 1000);
    expect(m).toEqual({ index: 2, name: 'Account 3', address: HARDHAT_2, path: "m/44'/60'/0'/0/2", createdAt: 1000 });
    expect(JSON.stringify(m)).not.toMatch(/private|seed|mnemonic/i);
  });

  it('keeps stored accounts that match the vault', async () => {
    const k = await HDKeyring.fromMnemonic(HARDHAT);
    const stored = [makeAccountMeta(0, HARDHAT_0, 'Main'), makeAccountMeta(3, k.evmAddress(3), 'Savings')];
    const r = reconcileAccounts(stored, indexesToVerify(stored).map((i) => k.evmAddress(i)));
    expect(r.status).toBe('ok');
    expect(r.accounts.map((a) => a.name)).toEqual(['Main', 'Savings']);
  });

  it('rebuilds accounts when stored metadata belongs to another phrase or is missing', async () => {
    const other = await HDKeyring.fromMnemonic(ABANDON);
    const stored = [makeAccountMeta(0, other.evmAddress(0)), makeAccountMeta(1, other.evmAddress(1))];
    const k = await HDKeyring.fromMnemonic(HARDHAT);
    const r = reconcileAccounts(stored, indexesToVerify(stored).map((i) => k.evmAddress(i)), 5);
    expect(r).toEqual({ status: 'rebuilt', accounts: [makeAccountMeta(0, HARDHAT_0, undefined, 5), makeAccountMeta(1, HARDHAT_1, undefined, 5)] });

    expect(indexesToVerify([])).toEqual([0]);
    expect(reconcileAccounts([], [HARDHAT_0], 5)).toEqual({ status: 'rebuilt', accounts: [makeAccountMeta(0, HARDHAT_0, undefined, 5)] });
  });

  it('signs only as the selected account: sender must match the signing index', async () => {
    const signer = new HDSigner(await HDKeyring.fromMnemonic(HARDHAT), new ConfirmationRegistry());
    const serializedUnsigned = serializeTransaction({ type: 'eip1559', chainId: 11155111, nonce: 0, to: HARDHAT_2, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    const payload = { kind: 'evm-transaction' as const, chainId: 11155111, from: HARDHAT_1, serializedUnsigned };

    const ok = await signer.sign({ account: { id: 'a1', hdIndex: 1 }, payload, confirmation: signer.confirmations.issue(payload) });
    expect(ok.kind).toBe('evm-ecdsa');
    // UI shows Account 2 (index 1) but asks index 0 to sign: refused.
    await expect(
      signer.sign({ account: { id: 'a0', hdIndex: 0 }, payload, confirmation: signer.confirmations.issue(payload) }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  });
});
