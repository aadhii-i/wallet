import type { DeviceKey } from './api-client';

/**
 * Generates a non-extractable P-256 key pair. The private key can be stored in
 * IndexedDB (CryptoKey is structured-cloneable) but its bytes can never be read.
 */
export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}

export function webCryptoDeviceKey(pair: CryptoKeyPair): DeviceKey {
  return {
    async publicKeySpki() {
      return new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    },
    async sign(message) {
      // WebCrypto ECDSA output is already IEEE P1363 (r||s).
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message as BufferSource);
      return new Uint8Array(sig);
    },
  };
}
