import type { HDKey } from '@scure/bip32';
import { mnemonicToSeedBytes, validateMnemonic } from '../mnemonic';
import {
  bitcoinAddressFromNode,
  btcAccountDescriptor,
  btcInternalDescriptor,
  btcSharedRootPath,
  encodeExtendedPublicKey,
  assertIndex,
  type BitcoinSharedContext,
  deriveBtcNode,
  deriveBtcChangeNode,
  deriveEvmNode,
  deriveHederaNode,
  hederaPublicKeyFromNode,
  masterKeyFromSeed,
  publicKeyToEvmAddress,
  type BitcoinAddressType,
  type BitcoinDescriptor,
  type BitcoinNetworkName,
} from '../derivation';
import { bytesToHex, wipe } from '../encoding';
import { SignerError, type Hex } from './types';

/**
 * Holds the unlocked HD root in memory. Private keys are derived on demand, used
 * inside a callback and wiped. Nothing here is ever persisted or serialized.
 */
export class HDKeyring {
  private master: HDKey | null;
  private readonly addressCache = new Map<string, string>();

  private constructor(master: HDKey) {
    this.master = master;
  }

  static async fromMnemonic(mnemonic: string, passphrase = ''): Promise<HDKeyring> {
    const v = validateMnemonic(mnemonic);
    if (!v.ok) throw new Error(`Invalid recovery phrase (${v.reason})`);
    const seed = await mnemonicToSeedBytes(mnemonic, passphrase);
    try {
      return new HDKeyring(masterKeyFromSeed(seed));
    } finally {
      wipe(seed);
    }
  }

  get locked(): boolean {
    return this.master === null;
  }

  evmAddress(index: number): Hex {
    const cached = this.addressCache.get(`evm|${index}`);
    if (cached) return cached as Hex;
    const node = deriveEvmNode(this.requireMaster(), index);
    try {
      const address = publicKeyToEvmAddress(node.publicKey!);
      this.addressCache.set(`evm|${index}`, address);
      return address;
    } finally {
      node.wipePrivateData();
    }
  }

  /**
   * BIP-84 (`p2wpkh`) or BIP-86 (`p2tr`) address for an account. Addresses are
   * public, so they are cached; private material never is.
   */
  btcAddress(
    index: number,
    addressType: BitcoinAddressType = 'p2wpkh',
    network: BitcoinNetworkName = 'mainnet',
  ): string {
    const key = `btc|${network}|${addressType}|${index}`;
    const cached = this.addressCache.get(key);
    if (cached) return cached;
    const node = deriveBtcNode(this.requireMaster(), index, addressType, network);
    try {
      const address = bitcoinAddressFromNode(node, addressType, network);
      this.addressCache.set(key, address);
      return address;
    } finally {
      node.wipePrivateData();
    }
  }

  /**
   * Account-level public descriptor for Bitcoin address derivation. Public
   * material only: the holder can derive this wallet's addresses but can
   * never spend from them.
   */
  btcDescriptor(
    addressType: BitcoinAddressType = 'p2wpkh',
    network: BitcoinNetworkName = 'mainnet',
  ): BitcoinDescriptor {
    return btcAccountDescriptor(this.requireMaster(), addressType, network);
  }

  btcChangeAddress(
    account: number,
    index: number,
    addressType: BitcoinAddressType,
    network: BitcoinNetworkName,
  ): string {
    const node = deriveBtcChangeNode(this.requireMaster(), account, index, addressType, network);
    try {
      return bitcoinAddressFromNode(node, addressType, network);
    } finally {
      node.wipePrivateData();
    }
  }

  btcChangeDescriptor(
    account: number,
    addressType: BitcoinAddressType,
    network: BitcoinNetworkName,
  ): BitcoinDescriptor {
    return btcInternalDescriptor(this.requireMaster(), account, addressType, network);
  }

  withBtcChangePrivateKey<T>(
    account: number,
    index: number,
    addressType: BitcoinAddressType,
    network: BitcoinNetworkName,
    fn: (privateKey: Uint8Array) => T,
  ): T {
    const node = deriveBtcChangeNode(this.requireMaster(), account, index, addressType, network);
    try {
      if (!node.privateKey) throw new SignerError('LOCKED', 'Private key unavailable');
      return fn(node.privateKey);
    } finally {
      node.wipePrivateData();
    }
  }

  btcSharedRoot(context: BitcoinSharedContext): string {
    const root = this.requireMaster().derive(btcSharedRootPath(context));
    try { return encodeExtendedPublicKey(root, context.network); }
    finally { root.wipePrivateData(); }
  }

  withBtcSharedPrivateKey<T>(context: BitcoinSharedContext, branch: 0 | 1, index: number, fn: (key: Uint8Array) => T): T {
    if (branch !== 0 && branch !== 1) throw new Error('Invalid shared Bitcoin branch');
    assertIndex(index);
    if (index >= 10000) throw new Error('Shared Bitcoin derivation limit reached');
    const node = this.requireMaster().derive(`${btcSharedRootPath(context)}/${branch}/${index}`);
    try {
      if (!node.privateKey) throw new SignerError('LOCKED', 'Private key unavailable');
      return fn(node.privateKey);
    } finally { node.wipePrivateData(); }
  }

  /**
   * Returns the compressed secp256k1 public key (33 bytes, lowercase hex)
   * for a Hedera account at the given HD index.
   *
   * The public key is used to identify the Hedera account before an on-chain
   * Account ID (shard.realm.num) is assigned. It is public material and safe
   * to cache.
   */
  hederaPublicKey(index: number): string {
    const key = `hedera|${index}`;
    const cached = this.addressCache.get(key);
    if (cached) return cached;
    const node = deriveHederaNode(this.requireMaster(), index);
    try {
      const pubKey = bytesToHex(hederaPublicKeyFromNode(node));
      this.addressCache.set(key, pubKey);
      return pubKey;
    } finally {
      node.wipePrivateData();
    }
  }

  /**
   * Runs `fn` with the Hedera account private key, then wipes the derived
   * node. Follows the same scoped-access pattern as withEvmPrivateKey and
   * withBtcPrivateKey.
   */
  withHederaPrivateKey<T>(index: number, fn: (privateKey: Uint8Array) => T): T {
    const node = deriveHederaNode(this.requireMaster(), index);
    try {
      const pk = node.privateKey;
      if (!pk) throw new SignerError('LOCKED', 'Private key unavailable');
      return fn(pk);
    } finally {
      node.wipePrivateData();
    }
  }

  /** Runs `fn` with the account private key, then wipes the derived node. */
  withEvmPrivateKey<T>(index: number, fn: (privateKey: Uint8Array) => T): T {
    const node = deriveEvmNode(this.requireMaster(), index);
    try {
      const pk = node.privateKey;
      if (!pk) throw new SignerError('LOCKED', 'Private key unavailable');
      return fn(pk);
    } finally {
      node.wipePrivateData();
    }
  }

  /**
   * Runs `fn` with the Bitcoin signing key for the account. For `p2tr` this is
   * the BIP-341 **internal** key: `@scure/btc-signer` applies the key-path tweak
   * itself when the PSBT input carries `tapInternalKey`.
   */
  withBtcPrivateKey<T>(
    index: number,
    addressType: BitcoinAddressType,
    network: BitcoinNetworkName,
    fn: (privateKey: Uint8Array) => T,
  ): T {
    const node = deriveBtcNode(this.requireMaster(), index, addressType, network);
    try {
      const pk = node.privateKey;
      if (!pk) throw new SignerError('LOCKED', 'Private key unavailable');
      return fn(pk);
    } finally {
      node.wipePrivateData();
    }
  }

  lock(): void {
    this.master?.wipePrivateData();
    this.master = null;
    this.addressCache.clear();
  }

  private requireMaster(): HDKey {
    if (!this.master) throw new SignerError('LOCKED', 'Wallet is locked');
    return this.master;
  }
}
