import { HDKey } from '@scure/bip32';
import { base58check, bech32, bech32m } from '@scure/base';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, concatBytes, fromHex, utf8ToBytes } from '../encoding';

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

// ---------------------------------------------------------------------------
// Bitcoin (BIP-84 P2WPKH, BIP-86 P2TR)
// ---------------------------------------------------------------------------

export type BitcoinAddressType = 'p2wpkh' | 'p2tr';
export type BitcoinNetworkName = 'mainnet' | 'testnet4';

/** BIP-43 purpose per address type: P2WPKH is BIP-84, P2TR is BIP-86. */
const BTC_PURPOSE: Record<BitcoinAddressType, number> = { p2wpkh: 84, p2tr: 86 };

/** BIP-32 extended public key version bytes (mainnet `xpub`, testnet `tpub`). */
const XPUB_VERSION = { mainnet: 0x0488b21e, testnet4: 0x043587cf } as const;

/** The account-level path both Bitcoin address types share: `m/{purpose}'/{coin}'/0'`. */
export function btcAccountPath(
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): string {
  const purpose = BTC_PURPOSE[addressType];
  if (purpose === undefined) throw new RangeError(`Unsupported Bitcoin address type: ${addressType}`);
  return `m/${purpose}'/${bitcoinCoinType(network)}'/0'`;
}

export interface BitcoinDescriptor {
  /**
   * Legacy receiving descriptor (does not include the new internal branch):
   * `wpkh([fingerprint/84'/0'/0']xpub.../0/*)` (BIP-84) or
   * `tr([fingerprint/86'/0'/0']xpub.../0/*)` (BIP-86).
   *
   * Public material only. It lets a client derive this wallet's addresses;
   * it can never spend from them.
   */
  descriptor: string;
  /** The account-level extended public key, without key origin. */
  xpub: string;
  /** Master key fingerprint, hex, as used in the key origin. */
  fingerprint: string;
}

/**
 * Builds the account-level public descriptor for a wallet master key. The
 * descriptor is derived from public data only, so it can be handed to a
 * watch-only node without ever exposing spending material.
 */
export function btcAccountDescriptor(
  master: HDKey,
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): BitcoinDescriptor {
  const path = btcAccountPath(addressType, network);
  const node = master.derive(path);
  try {
    const xpub = encodeExtendedPublicKey(node, network);
    const fingerprint = bytesToHex(u32be(master.fingerprint));
    const script = addressType === 'p2tr' ? 'tr' : 'wpkh';
    // The origin records where the account key came from, so a node can show
    // the derivation path without ever learning the master key.
    const origin = `[${fingerprint}${path.slice(1)}]`;
    return { descriptor: `${script}(${origin}${xpub}/0/*)`, xpub, fingerprint };
  } finally {
    node.wipePrivateData();
  }
}

/** Internal descriptor paired with the preserved legacy receive descriptor. */
export function btcInternalDescriptor(master: HDKey, account: number, addressType: BitcoinAddressType, network: BitcoinNetworkName): BitcoinDescriptor {
  const path = btcChangePath(account, 0, addressType, network).split('/').slice(0, 4).join('/');
  const node = master.derive(path);
  try {
    const xpub = encodeExtendedPublicKey(node, network);
    const fingerprint = bytesToHex(u32be(master.fingerprint));
    const script = addressType === 'p2tr' ? 'tr' : 'wpkh';
    return { descriptor: `${script}([${fingerprint}${path.slice(1)}]${xpub}/1/*)`, xpub, fingerprint };
  } finally { node.wipePrivateData(); }
}

/** Serializes an extended public key with the version bytes of its network. */
export function encodeExtendedPublicKey(node: HDKey, network: BitcoinNetworkName): string {
  const publicKey = node.publicKey;
  const chainCode = node.chainCode;
  if (!publicKey || !chainCode) throw new Error('Public key unavailable');
  const bytes = concatBytes(
    u32be(XPUB_VERSION[network]),
    Uint8Array.of(node.depth),
    u32be(node.parentFingerprint),
    u32be(node.index),
    chainCode,
    publicKey,
  );
  return base58check(sha256).encode(bytes);}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function bitcoinCoinType(network: BitcoinNetworkName): 0 | 1 {
  return network === 'mainnet' ? 0 : 1;
}

export function bitcoinHrp(network: BitcoinNetworkName): 'bc' | 'tb' {
  return network === 'mainnet' ? 'bc' : 'tb';
}

/** `m/84'/coin'/0'/0/{index}` or `m/86'/coin'/0'/0/{index}`. */
export function btcDerivationPath(
  index: number,
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): string {
  assertIndex(index);
  const purpose = BTC_PURPOSE[addressType];
  if (purpose === undefined) throw new RangeError(`Unsupported Bitcoin address type: ${addressType}`);
  return `m/${purpose}'/${bitcoinCoinType(network)}'/0'/0/${index}`;
}

/** Derives the Bitcoin key node for an account. The caller must wipe it after use. */
export function deriveBtcNode(
  master: HDKey,
  index: number,
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): HDKey {
  return master.derive(btcDerivationPath(index, addressType, network));
}

/** Version 1 internal branch. Legacy receive paths remain unchanged. */
export function btcChangePath(account: number, index: number, addressType: BitcoinAddressType, network: BitcoinNetworkName): string {
  assertIndex(account);
  assertIndex(index);
  const purpose = BTC_PURPOSE[addressType];
  if (purpose === undefined) throw new RangeError('Unsupported Bitcoin address type');
  return `m/${purpose}'/${bitcoinCoinType(network)}'/${account}'/1/${index}`;
}

export function deriveBtcChangeNode(master: HDKey, account: number, index: number, addressType: BitcoinAddressType, network: BitcoinNetworkName): HDKey {
  return master.derive(btcChangePath(account, index, addressType, network));
}

export interface BitcoinSharedContext {
  walletId: string;
  accountId: string;
  keygenId: string;
  membershipVersion: number;
  network: BitcoinNetworkName;
}

/** Separate hardened namespace: never reuse a personal Bitcoin key. */
export function btcSharedRootPath(context: BitcoinSharedContext): string {
  for (const id of [context.walletId, context.accountId, context.keygenId]) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid shared Bitcoin identity');
  }
  assertIndex(context.membershipVersion);
  const digest = sha256(utf8ToBytes(JSON.stringify(['QDWallet-BitcoinNative/v1', context.walletId,
    context.accountId, context.keygenId, context.membershipVersion, context.network])));
  const words = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const scope = Array.from({length:8}, (_, i) => `${words.getUint32(i*4) & MAX_ACCOUNT_INDEX}'`);
  return `m/48'/${bitcoinCoinType(context.network)}'/0'/2'/${scope.join('/')}`;
}

/** RIPEMD160(SHA256(data)) — the hash used by P2WPKH witness programs. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * BIP-341 key-path-only Taproot output key for a secp256k1 public key.
 * `t = taggedHash("TapTweak", x(P))`, `Q = lift_x(x(P)) + t*G`, returns `x(Q)`.
 */
export function taprootOutputKey(publicKey: Uint8Array): Uint8Array {
  const xOnly = publicKey.length === 33 ? publicKey.subarray(1) : publicKey;
  if (xOnly.length !== 32) throw new Error('Invalid secp256k1 public key');
  const internal = schnorr.utils.lift_x(BigInt(`0x${bytesToHex(xOnly)}`));
  const tweakBytes = sha256Tagged('TapTweak', xOnly);
  const tweak = BigInt(`0x${bytesToHex(tweakBytes)}`);
  const output = internal.add(secp256k1.Point.BASE.multiply(tweak));
  return output.toBytes(true).subarray(1);
}

/** BIP-340 tagged hash (independent of noble's schnorr helper, so this stays local). */
function sha256Tagged(tag: string, ...messages: Uint8Array[]): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(tagHash, tagHash, ...messages));
}

/**
 * BIP-341 key-path signing key: `t = taggedHash("TapTweak", x(P))`,
 * `d' = (d if P has even Y else n - d) + t (mod n)`.
 * Returns a fresh array; the caller owns and must wipe it.
 */
export function taprootTweakPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 33) throw new Error('Taproot tweak requires a compressed public key');
  const xOnly = publicKey.subarray(1);
  const n = secp256k1.Point.CURVE().n;
  const d = BigInt(`0x${bytesToHex(privateKey)}`);
  const dNorm = (publicKey[0]! & 1) === 1 ? n - d : d;
  const tweak = BigInt(`0x${bytesToHex(sha256Tagged('TapTweak', xOnly))}`);
  const tweaked = (dNorm + tweak) % n;
  if (tweaked === 0n) throw new Error('Invalid Taproot tweak');
  return fromHex(tweaked.toString(16).padStart(64, '0'));
}

/** Encodes a segwit address: v0 uses bech32, v1+ uses bech32m (BIP-173/BIP-350). */
function encodeSegwitAddress(hrp: string, version: number, program: Uint8Array): string {
  const codec = version === 0 ? bech32 : bech32m;
  return codec.encode(hrp, [version, ...codec.toWords(program)]);
}

/** Segwit address for a public key. P2WPKH compresses; P2TR uses the tweaked output key. */
export function bitcoinAddressFromPublicKey(
  publicKey: Uint8Array,
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): string {
  const hrp = bitcoinHrp(network);
  if (addressType === 'p2wpkh') {
    const compressed = publicKey.length === 33 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(true);
    return encodeSegwitAddress(hrp, 0, hash160(compressed));
  }
  if (addressType === 'p2tr') {
    return encodeSegwitAddress(hrp, 1, taprootOutputKey(publicKey));
  }
  throw new RangeError(`Unsupported Bitcoin address type: ${addressType}`);
}

/** Address for a derived node. Never touches the private key. */
export function bitcoinAddressFromNode(
  node: HDKey,
  addressType: BitcoinAddressType = 'p2wpkh',
  network: BitcoinNetworkName = 'mainnet',
): string {
  if (!node.publicKey) throw new Error('Public key unavailable');
  return bitcoinAddressFromPublicKey(node.publicKey, addressType, network);
}

export interface DecodedBitcoinAddress {
  hrp: 'bc' | 'tb';
  version: number;
  program: Uint8Array;
  /** Only the two types this wallet creates are reported; anything else is `other`. */
  type: BitcoinAddressType | 'other';
}

/**
 * Decodes and validates a segwit address, including the BIP-350 checksum variant.
 * Rejects mixed case, unknown HRPs, and witness versions/programs we do not support.
 */
export function decodeBitcoinAddress(address: string): DecodedBitcoinAddress {
  if (address !== address.toLowerCase()) throw new Error('Mixed-case Bitcoin address');
  const decoded = bech32.decodeUnsafe(address, 90);
  const decodedM = decoded ? undefined : bech32m.decodeUnsafe(address, 90);
  const found = decoded ?? decodedM;
  if (!found) throw new Error('Bad Bitcoin address checksum');
  const { prefix, words } = found;
  if (prefix !== 'bc' && prefix !== 'tb') throw new Error(`Unsupported Bitcoin address prefix: ${prefix}`);
  const version = words[0];
  if (version === undefined || version > 16) throw new Error('Invalid witness version');
  if ((version === 0) !== !decodedM) throw new Error('Wrong checksum variant for witness version');
  const program = bech32.fromWords(words.slice(1));
  if (program.length < 2 || program.length > 40) throw new Error('Invalid witness program length');
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error('Invalid v0 witness program length');
  }
  let type: BitcoinAddressType | 'other' = 'other';
  if (version === 0 && program.length === 20) type = 'p2wpkh';
  else if (version === 1 && program.length === 32) type = 'p2tr';
  return { hrp: prefix, version, program, type };
}

/** True only when the address is a supported type on the given network. */
export function isValidBitcoinAddress(
  address: string,
  network: BitcoinNetworkName = 'mainnet',
  allowedTypes: readonly BitcoinAddressType[] = ['p2wpkh', 'p2tr'],
): boolean {
  try {
    const d = decodeBitcoinAddress(address);
    return d.hrp === bitcoinHrp(network) && d.type !== 'other' && allowedTypes.includes(d.type);
  } catch {
    return false;
  }
}

/**
 * Compact proof of address ownership for backend registration:
 * `0x` + 33-byte compressed public key + 64-byte low-S ECDSA signature over
 * `sha256(message)`. `@noble/curves` hashes secp256k1 messages with SHA-256 by
 * default, matching Bitcoin's message-signing convention.
 *
 * For P2TR the caller passes the **internal** key; the verifier re-applies the
 * BIP-341 tweak before comparing against the address witness program.
 */
export function btcOwnershipProof(privateKey: Uint8Array, message: string): `0x${string}` {
  const signature = secp256k1.sign(utf8ToBytes(message), privateKey);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return `0x${bytesToHex(concatBytes(publicKey, signature))}`;
}

// ---------------------------------------------------------------------------
// Hedera (BIP-44, secp256k1, SLIP-44 coin type 3030)
// ---------------------------------------------------------------------------

/** SLIP-44 coin type for HBAR (https://github.com/satoshilabs/slips/blob/master/slip-0044.md). */
export const HEDERA_COIN_TYPE = 3030;

/**
 * BIP-44 Hedera derivation path: m/44'/3030'/0'/0/{index}.
 *
 * Uses the same secp256k1 curve as EVM derivation; only the coin type differs.
 * Both Hedera and HashPack wallets use this path for ECDSA (secp256k1) accounts.
 */
export function hederaDerivationPath(index: number): string {
  assertIndex(index);
  return `m/44'/${HEDERA_COIN_TYPE}'/0'/0/${index}`;
}

/** Derives the Hedera key node for an account. The caller must wipe it after use. */
export function deriveHederaNode(master: HDKey, index: number): HDKey {
  return master.derive(hederaDerivationPath(index));
}

/**
 * Returns the compressed secp256k1 public key (33 bytes) for a Hedera account.
 *
 * Hedera ECDSA accounts accept a 33-byte compressed public key as their
 * identifying key material. @scure/bip32 always stores publicKey in compressed
 * form, so no conversion is needed.
 */
export function hederaPublicKeyFromNode(node: HDKey): Uint8Array {
  if (!node.publicKey) throw new Error('Public key unavailable');
  return node.publicKey;
}
