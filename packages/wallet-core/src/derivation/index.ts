import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '../encoding';

/** Hardened-account BIP-44 constants (ADR-010). */
export const EVM_COIN_TYPE = 60;
export const MAX_ACCOUNT_INDEX = 0x7fffffff;

/**
 * MetaMask-compatible EVM path: m/44'/60'/0'/0/{index}.
 * The same phrase yields the same addresses in MetaMask and QD Wallet.
 */
export function evmDerivationPath(index: number): string {
  assertIndex(index);
  return `m/44'/${EVM_COIN_TYPE}'/0'/0/${index}`;
}

export function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX) {
    throw new RangeError(`Invalid account index: ${index}`);
  }
}

export function masterKeyFromSeed(seed: Uint8Array): HDKey {
  return HDKey.fromMasterSeed(seed);
}

/** Derives the EVM key node for an account. The caller must wipe it after use. */
export function deriveEvmNode(master: HDKey, index: number): HDKey {
  return master.derive(evmDerivationPath(index));
}

export function publicKeyToEvmAddress(publicKey: Uint8Array): `0x${string}` {
  const uncompressed =
    publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  return toChecksumAddress(`0x${bytesToHex(hash.subarray(12))}`);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddressFormat(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(address: string): `0x${string}` {
  if (!ADDRESS_RE.test(address)) throw new Error('Invalid EVM address');
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out as `0x${string}`;
}

/**
 * EIP-55 validation. All-lowercase or all-uppercase inputs carry no checksum and are
 * accepted; mixed-case inputs must match the checksum exactly (spec §16.2).
 */
export function isValidEvmChecksum(address: string): boolean {
  if (!ADDRESS_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}
