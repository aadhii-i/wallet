// The Solidity verifier and smart account against the TypeScript reference
// (packages/qd-crypto), on a real EVM (Anvil). Signatures come from the real
// three-round protocol run in-process here; the networked session is tested
// in packages/rpc and the browser E2E.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  K,
  L,
  N,
  NORM_BOUND,
  QdParty,
  dealerKeyGen,
  encodePublicKey,
  encodeSignature,
  expandACoefficients,
  publicKeyHash,
  signLocally,
  verify,
  type KeyShare,
} from '@qd/qd-crypto';
import {
  EIP7825_TX_GAS_CAP,
  MATRIX_ENTRIES,
  MATRIX_ENTRIES_PER_TX,
  QdAccount,
  QdAccountFactory,
  QdRaccoonVerifier,
  accountAddress,
  createAccountCalldata,
  executeCalldata,
  executionMessage,
  expandMatrixCalldata,
  factoryAddress,
  publicKeyHashHex,
  verifierAddress,
  type AccountCall,
} from '../src';
import { ANVIL_KEY_1, anvilBinary, deployContracts, startAnvil, type Anvil } from './anvil';

const HAVE_ANVIL = anvilBinary() !== null;
if (!HAVE_ANVIL) console.warn('SKIPPED: anvil not installed (set ANVIL_BIN or install Foundry)');

const fromHex = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
// Test-only BigInt mirror of the contract's NTT mod P (Cooley–Tukey, zetas[k] = ψ^{brv9(k)}).
const P = 0xffffffffffffffffffffffffff9c01n;
const modpow = (b: bigint, e: bigint) => {
  let r = 1n;
  let x = b % P;
  for (let k = e; k > 0n; k >>= 1n) {
    if (k & 1n) r = (r * x) % P;
    x = (x * x) % P;
  }
  return r;
};
const u128s = (code: Uint8Array) =>
  Array.from({ length: 512 }, (_, c) => BigInt('0x' + Array.from(code.subarray(1 + 16 * c, 17 + 16 * c), (b) => b.toString(16).padStart(2, '0')).join('')));
function nttP(coeffs: bigint[], zetas: bigint[]): bigint[] {
  const a = coeffs.slice();
  let k = 0;
  for (let len = 256; len > 0; len >>= 1) {
    for (let start = 0; start < 512; start += 2 * len) {
      const zeta = zetas[++k]!;
      for (let j = start; j < start + len; j++) {
        const u = a[j]!;
        const v = (zeta * a[j + len]!) % P;
        a[j] = (u + v) % P;
        a[j + len] = (u - v + P) % P;
      }
    }
  }
  return a;
}
const sid = () => crypto.getRandomValues(new Uint8Array(32));

describe.skipIf(!HAVE_ANVIL)('QdRaccoonVerifier and QdAccount on Anvil', () => {
  let a: Anvil;
  let shares: KeyShare[];
  const derivationIndex = 3;
  let pk: Uint8Array;
  let vk: Hex;
  let seedA: Hex;
  const gas: Record<string, bigint> = {};

  const send = async (to: Address, data: Hex, value = 0n) => {
    const hash = await a.wallet.sendTransaction({ to, data, value, account: a.wallet.account!, chain: a.wallet.chain, gas: 29_000_000n });
    return a.publicClient.waitForTransactionReceipt({ hash });
  };
  /** Sends with a fixed gas limit (no estimation) and expects the transaction to revert on chain. */
  const reverts = async (to: Address, data: Hex) => {
    const r = await send(to, data);
    expect(r.status).toBe('reverted');
  };
  const onChainVerify = (pubKey: Uint8Array, msg: Hex, sig: Uint8Array) =>
    a.publicClient.readContract({
      address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'verify', args: [toHex(pubKey), msg, toHex(sig)],
    });
  const sign = (act: number[], msg: Hex) => {
    const parties = act.map((i) => new QdParty(shares[i - 1]!));
    return signLocally(parties, { sid: sid(), act, derivationIndex, msg: fromHex(msg) });
  };

  beforeAll(async () => {
    a = await startAnvil();
    await deployContracts(a);
    shares = dealerKeyGen(2, 3).shares; // test fixture: trusted dealer in-process
    const pub = new QdParty(shares[0]!).publicKey(derivationIndex);
    pk = encodePublicKey(pub);
    vk = toHex(publicKeyHash(pub));
    seedA = toHex(pub.seedA);
    // MATRIX_ENTRIES_PER_TX entries per transaction keeps each one under the
    // EIP-7825 per-transaction cap that public chains enforce.
    for (let first = 0; first < MATRIX_ENTRIES; first += MATRIX_ENTRIES_PER_TX) {
      const r = await send(verifierAddress(), expandMatrixCalldata(seedA, first, MATRIX_ENTRIES_PER_TX));
      expect(r.status).toBe('success');
      expect(r.gasUsed).toBeLessThan(EIP7825_TX_GAS_CAP);
      gas[`expandMatrix(${MATRIX_ENTRIES_PER_TX} entries) #${first / MATRIX_ENTRIES_PER_TX}`] = r.gasUsed;
    }
  }, 300_000);

  afterAll(() => {
    a?.stop();
    console.log('gas used:', Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, v.toString()])));
  });

  it('deploys to the deterministic addresses and agrees on constants', async () => {
    expect(await a.publicClient.readContract({ address: factoryAddress(), abi: QdAccountFactory.abi, functionName: 'verifier' })).toBe(verifierAddress());
    const bound = await a.publicClient.readContract({ address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'NORM_BOUND_SQ' });
    expect(bound).toBe(BigInt(NORM_BOUND * NORM_BOUND));
    expect(publicKeyHashHex(pk)).toBe(vk);
    expect(await a.publicClient.readContract({ address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'publicKeyHash', args: [toHex(pk)] })).toBe(vk);
  });

  it('the on-chain matrix is NTT_P of qd-crypto\'s expandA coefficients, entry by entry', async () => {
    expect(await a.publicClient.readContract({ address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'matrixReady', args: [seedA] })).toBe(true);
    const A = expandACoefficients(fromHex(seedA));
    const zetaCode = fromHex((await a.publicClient.getCode({
      address: await a.publicClient.readContract({ address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'zetaData' }),
    }))!);
    const zetas = u128s(zetaCode);
    // zetas are ψ^{brv9(i)} for a primitive 1024th root ψ mod P.
    const psi = zetas[256]!; // brv9(256) = 1
    expect(zetas[0]).toBe(1n);
    expect(modpow(psi, 512n)).toBe(P - 1n); // ψ has order exactly 1024
    expect(zetas[1]).toBe(modpow(psi, 256n));
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < L; j++) {
        const entry = await a.publicClient.readContract({
          address: verifierAddress(), abi: QdRaccoonVerifier.abi, functionName: 'matrixEntry', args: [seedA, BigInt(i * L + j)],
        });
        const code = fromHex((await a.publicClient.getCode({ address: entry }))!);
        expect(code.length).toBe(8193);
        expect(code[0]).toBe(0);
        expect(u128s(code)).toEqual(nttP(Array.from(A[i]![j]!, (x) => BigInt(x)), zetas));
      }
    }
  });

  it('accepts real threshold signatures from different signer subsets (2-of-3)', async () => {
    for (const act of [[1, 2], [1, 3], [2, 3]]) {
      const msg = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const sig = sign(act, msg);
      expect(verify(new QdParty(shares[0]!).publicKey(derivationIndex), fromHex(msg), sig)).toBe(true);
      expect(await onChainVerify(pk, msg, encodeSignature(sig))).toBe(true);
    }
    const msg = toHex(crypto.getRandomValues(new Uint8Array(32)));
    gas['verify (eth_estimateGas)'] = await a.publicClient.estimateGas({
      to: verifierAddress(), account: a.wallet.account!,
      data: encodeFunctionData({ abi: QdRaccoonVerifier.abi, functionName: 'verify', args: [toHex(pk), msg, toHex(encodeSignature(sign([1, 2], msg)))] }),
    });
  }, 120_000);

  it('rejects altered messages, signatures, keys and non-canonical encodings', async () => {
    const msg = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const good = encodeSignature(sign([2, 3], msg));
    expect(await onChainVerify(pk, msg, good)).toBe(true);
    const other = toHex(crypto.getRandomValues(new Uint8Array(32)));
    expect(await onChainVerify(pk, other, good)).toBe(false); // altered message

    const mutate = (f: (b: Uint8Array) => void) => {
      const b = good.slice();
      f(b);
      return b;
    };
    const zOff = 38;
    const hOff = 38 + L * N * 7;
    const cases: [string, Uint8Array][] = [
      ['z coefficient changed', mutate((b) => { b[zOff + 6]! ^= 1; })],
      ['h coefficient changed', mutate((b) => { b[hOff + 1] = (b[hOff + 1]! + 1) % 250; })],
      ['challenge sign flipped', mutate((b) => { b[0]! ^= 0x80; })],
      ['challenge position changed', mutate((b) => { b[1]! ^= 1; })],
      ['challenge reserved bits set', mutate((b) => { b[0]! |= 0x02; })],
      ['duplicate challenge position', mutate((b) => { b[2] = b[0]!; b[3] = b[1]!; })],
      ['z ≥ q', mutate((b) => { b.fill(0xff, zOff, zOff + 7); })],
      ['h ≥ q_w', mutate((b) => { b[hOff] = 0x01; b[hOff + 1] = 0xf4; })],
      ['all-zero signature', new Uint8Array(good.length)],
    ];
    for (const [what, sig] of cases) {
      expect(await onChainVerify(pk, msg, sig), what).toBe(false);
    }
    expect(await onChainVerify(pk, msg, good.slice(0, -1))).toBe(false); // truncated

    // Wrong key: another derivation index of the same master key (same seedA, so the matrix is ready).
    const otherPk = encodePublicKey(new QdParty(shares[0]!).publicKey(derivationIndex + 1));
    expect(await onChainVerify(otherPk, msg, good)).toBe(false);
    const badT = pk.slice();
    badT[32] = 0xff; // t coefficient ≥ q_t
    expect(await onChainVerify(badT, msg, good)).toBe(false);
  }, 120_000);

  it('a signature whose norm exceeds the bound is rejected (bound enforced exactly)', async () => {
    // Scale z: a real signature with z replaced by a large-norm vector must fail
    // the norm check before anything else (TS and Solidity agree).
    const msg = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const sig = sign([1, 2], msg);
    const big = { ...sig, z: sig.z.map((p) => p.map(() => 2 ** 47)) };
    expect(verify(new QdParty(shares[0]!).publicKey(derivationIndex), fromHex(msg), big)).toBe(false);
    expect(await onChainVerify(pk, msg, encodeSignature(big))).toBe(false);
  }, 60_000);

  it('executes a Raccoon-authorised ETH transfer; replay, wrong chain, expiry and wrong key fail', async () => {
    const account = accountAddress(vk);
    expect(await a.publicClient.readContract({ address: factoryAddress(), abi: QdAccountFactory.abi, functionName: 'accountAddress', args: [vk] })).toBe(account);
    // Counterfactual: fund first, deploy later.
    await send(account, '0x', parseEther('1'));
    const created = await send(factoryAddress(), createAccountCalldata(vk));
    gas['createAccount'] = created.gasUsed;
    expect(await a.publicClient.getCode({ address: account })).toBeTruthy();

    const recipient = privateKeyToAccount(ANVIL_KEY_1).address === account ? account : ('0x' + 'ab'.repeat(20)) as Address;
    const before = await a.publicClient.getBalance({ address: recipient });
    const block = await a.publicClient.getBlock();
    const call: AccountCall = {
      nonce: 0n, to: recipient, value: parseEther('0.02'), data: '0x', callGasLimit: 21_000n,
      validUntil: block.timestamp + 3600n, proposalDigest: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const msg = executionMessage(BigInt(a.chainId), account, call);
    expect(await a.publicClient.readContract({ address: account, abi: QdAccount.abi, functionName: 'executionMessage', args: [call] })).toBe(msg);

    // Signed for the wrong chain id: rejected.
    const wrongChain = encodeSignature(sign([1, 3], executionMessage(1n, account, call)));
    await reverts(account, executeCalldata(call, pk, wrongChain));

    const sig = encodeSignature(sign([1, 3], msg));
    const r = await send(account, executeCalldata(call, pk, sig));
    expect(r.status).toBe('success');
    gas['execute (ETH transfer)'] = r.gasUsed;
    expect(r.gasUsed).toBeLessThan(EIP7825_TX_GAS_CAP);
    expect(await a.publicClient.getBalance({ address: recipient })).toBe(before + parseEther('0.02'));
    expect(await a.publicClient.getBalance({ address: account })).toBe(parseEther('0.98'));
    expect(await a.publicClient.readContract({ address: account, abi: QdAccount.abi, functionName: 'nonce' })).toBe(1n);

    // Replay of the same authorised call: the nonce is spent.
    await reverts(account, executeCalldata(call, pk, sig));
    // A valid signature by the same key for a different call does not authorise this one.
    const call2 = { ...call, nonce: 1n, value: parseEther('0.5') };
    await reverts(account, executeCalldata(call2, pk, sig));
    // Expired.
    const expired = { ...call2, validUntil: block.timestamp - 1n };
    await reverts(account, executeCalldata(expired, pk, encodeSignature(sign([1, 2], executionMessage(BigInt(a.chainId), account, expired)))));
    // Right signature, different public key presented.
    const otherPk = encodePublicKey(new QdParty(shares[0]!).publicKey(derivationIndex + 1));
    const s2 = encodeSignature(sign([1, 2], executionMessage(BigInt(a.chainId), account, call2)));
    await reverts(account, executeCalldata(call2, otherPk, s2));
    expect(await a.publicClient.getBalance({ address: account })).toBe(parseEther('0.98'));
  }, 180_000);

  it('a reverting inner call consumes the nonce, moves no value, and reports success = false', async () => {
    const account = accountAddress(vk);
    const nonce = await a.publicClient.readContract({ address: account, abi: QdAccount.abi, functionName: 'nonce' });
    const block = await a.publicClient.getBlock();
    // The factory has no payable fallback, so this call reverts.
    const call: AccountCall = {
      nonce, to: factoryAddress(), value: parseEther('0.1'), data: '0xdeadbeef', callGasLimit: 100_000n,
      validUntil: block.timestamp + 3600n, proposalDigest: toHex(new Uint8Array(32)),
    };
    const balance = await a.publicClient.getBalance({ address: account });
    const r = await send(account, executeCalldata(call, pk, encodeSignature(sign([2, 3], executionMessage(BigInt(a.chainId), account, call)))));
    expect(r.status).toBe('success');
    const log = r.logs.find((l) => l.address.toLowerCase() === account.toLowerCase());
    expect(log).toBeTruthy();
    // Executed(uint256 indexed nonce, bytes32 indexed message, bytes32 indexed proposalDigest, address to, uint256 value, bool success)
    expect(BigInt('0x' + log!.data.slice(2 + 128, 2 + 192))).toBe(0n); // success = false
    expect(await a.publicClient.getBalance({ address: account })).toBe(balance);
    expect(await a.publicClient.readContract({ address: account, abi: QdAccount.abi, functionName: 'nonce' })).toBe(nonce + 1n);
  }, 120_000);

  it('verify reverts (does not return false) while the matrix for a new key is missing', async () => {
    const fresh = new QdParty(dealerKeyGen(1, 1).shares[0]!);
    const msg = toHex(new Uint8Array(32));
    await expect(onChainVerify(encodePublicKey(fresh.publicKey(0)), msg, new Uint8Array(19494))).rejects.toThrow(/MatrixNotReady/);
  });
});
