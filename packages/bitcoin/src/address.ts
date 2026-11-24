import type { BitcoinAddressType, BitcoinChain, BitcoinNetwork } from '@qd/blockchain';
import {
  bitcoinHrp,
  bytesToHex,
  decodeBitcoinAddress,
  fromHex,
  isValidBitcoinAddress,
} from '@qd/wallet-core';

export { decodeBitcoinAddress, isValidBitcoinAddress, bitcoinHrp };

/** `bc` (mainnet) or `tb` (testnet4). */
export function hrpForChain(chain: BitcoinChain): 'bc' | 'tb' {
  return chain === 'mainnet' ? 'bc' : 'tb';
}

export interface BitcoinAddressCheck {
  valid: boolean;
  type?: BitcoinAddressType | 'p2wsh';
  /** Canonical (lowercase) form. */
  normalized?: string;
  reason?: 'format' | 'checksum' | 'network';
}

/**
 * Validates an address against a network and its enabled address types.
 * Distinguishes a wrong-network address from a malformed one so the UI can say
 * which mistake the user made.
 */
export function checkBitcoinAddress(input: string, network: BitcoinNetwork): BitcoinAddressCheck {
  const trimmed = input.trim();
  try {
    const decoded = decodeBitcoinAddress(trimmed);
    if (decoded.hrp !== hrpForChain(network.bitcoin.chain)) {
      return { valid: false, reason: 'network', normalized: trimmed.toLowerCase() };
    }
    if (decoded.version===0 && decoded.program.length===32) return {valid:true,type:'p2wsh',normalized:trimmed};
    if (decoded.type === 'other' || !network.bitcoin.addressTypes.includes(decoded.type)) {
      return { valid: false, reason: 'format', normalized: trimmed.toLowerCase() };
    }
    return { valid: true, type: decoded.type, normalized: trimmed.toLowerCase() };
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    return {
      valid: false,
      reason: message.toLowerCase().includes('checksum') ? 'checksum' : 'format',
    };
  }
}

export function isValidBitcoinDestination(address: string, chain: BitcoinChain): boolean {
  try {
    const decoded=decodeBitcoinAddress(address);
    return decoded.hrp===hrpForChain(chain) && (decoded.type!=='other'||(decoded.version===0&&decoded.program.length===32));
  } catch {return false;}
}

/** `scriptPubKey` for a segwit address: `OP_n <program>`. */
export function scriptPubKeyForAddress(address: string): Uint8Array {
  const decoded = decodeBitcoinAddress(address);
  const op = decoded.version === 0 ? 0x00 : 0x50 + decoded.version;
  return new Uint8Array([op, decoded.program.length, ...decoded.program]);
}

export function scriptPubKeyHex(address: string): string {
  return bytesToHex(scriptPubKeyForAddress(address));
}

/** True when a Core-provided script matches the address we asked about. */
export function scriptMatchesAddress(scriptHex: string, address: string): boolean {
  try {
    return bytesToHex(fromHex(scriptHex)) === scriptPubKeyHex(address);
  } catch {
    return false;
  }
}
