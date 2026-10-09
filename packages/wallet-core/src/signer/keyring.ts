import type { HDKey } from '@scure/bip32';
import { mnemonicToSeedBytes, validateMnemonic } from '../mnemonic';
import { deriveEvmNode, masterKeyFromSeed, publicKeyToEvmAddress } from '../derivation';
import { wipe } from '../encoding';
import { SignerError, type Hex } from './types';

/**
 * Holds the unlocked HD root in memory. Private keys are derived on demand, used
 * inside a callback and wiped. Nothing here is ever persisted or serialized.
 */
export class HDKeyring {
  private master: HDKey | null;
  private readonly addressCache = new Map<number, Hex>();

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
    const cached = this.addressCache.get(index);
    if (cached) return cached;
    const node = deriveEvmNode(this.requireMaster(), index);
    try {
      const address = publicKeyToEvmAddress(node.publicKey!);
      this.addressCache.set(index, address);
      return address;
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
