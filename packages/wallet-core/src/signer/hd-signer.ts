import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, fromHex, toHex, utf8ToBytes } from '../encoding';
import { ConfirmationRegistry } from './confirmation';
import type { HDKeyring } from './keyring';
import {
  SignerError,
  type AccountRef,
  type ChainFamily,
  type Hex,
  type SignatureResult,
  type Signer,
  type SigningRequest,
} from './types';

/** Only EIP-1559 (type 2) transactions are signed in V1; 0x04 (EIP-7702) is deliberately excluded. */
const EIP1559_TYPE = 0x02;

/**
 * Reads the chain id (first field) of a type-2 payload: 0x02 || rlp([chainId, ...]).
 * Minimal RLP reader for exactly this purpose; throws on anything malformed.
 */
export function readTypedTxChainId(bytes: Uint8Array): bigint {
  if (bytes[0] !== EIP1559_TYPE) throw new SignerError('INVALID_PAYLOAD', 'Only EIP-1559 transactions are signed');
  let i = 1;
  const listPrefix = bytes[i]!;
  if (listPrefix < 0xc0) throw new SignerError('INVALID_PAYLOAD', 'Malformed transaction');
  i += listPrefix <= 0xf7 ? 1 : 1 + (listPrefix - 0xf7);
  const p = bytes[i];
  if (p === undefined) throw new SignerError('INVALID_PAYLOAD', 'Malformed transaction');
  if (p < 0x80) return BigInt(p);
  if (p > 0x88) throw new SignerError('INVALID_PAYLOAD', 'Malformed chain id');
  const len = p - 0x80;
  let v = 0n;
  for (let k = 1; k <= len; k++) {
    const b = bytes[i + k];
    if (b === undefined) throw new SignerError('INVALID_PAYLOAD', 'Malformed transaction');
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/** Conventional BIP-32/44 signer (Milestone 1). Replaceable by MPC/QD signers (spec §13.2). */
export class HDSigner implements Signer {
  readonly kind = 'hd' as const;

  constructor(
    private readonly keyring: HDKeyring,
    readonly confirmations: ConfirmationRegistry = new ConfirmationRegistry(),
  ) {}

  supports(chainFamily: ChainFamily): boolean {
    return chainFamily === 'evm';
  }

  async getAddress(account: AccountRef, chainFamily: ChainFamily): Promise<Hex> {
    if (!this.supports(chainFamily)) throw new SignerError('UNSUPPORTED', `HD signer: ${chainFamily} not supported yet`);
    return this.keyring.evmAddress(account.hdIndex);
  }

  async sign({ account, payload, confirmation }: SigningRequest): Promise<SignatureResult> {
    if (this.keyring.locked) throw new SignerError('LOCKED', 'Wallet is locked');
    this.confirmations.consume(confirmation, payload);

    const expected = this.keyring.evmAddress(account.hdIndex);
    if (expected.toLowerCase() !== payload.from.toLowerCase()) {
      throw new SignerError('ACCOUNT_MISMATCH', 'Payload sender does not match the selected account');
    }

    switch (payload.kind) {
      case 'evm-transaction': {
        const bytes = fromHex(payload.serializedUnsigned);
        // The chain id inside the signed bytes must be the one the UI declared (replay protection).
        if (readTypedTxChainId(bytes) !== BigInt(payload.chainId)) {
          throw new SignerError('INVALID_PAYLOAD', 'Transaction chain does not match the selected network');
        }
        const digest = keccak_256(bytes);
        const sig = this.keyring.withEvmPrivateKey(account.hdIndex, (pk) => signDigest(digest, pk));
        return { kind: 'evm-ecdsa', signerKind: this.kind, ...sig };
      }
      case 'evm-personal-message': {
        const msg = fromHex(payload.message);
        const digest = keccak_256(
          concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg),
        );
        const sig = this.keyring.withEvmPrivateKey(account.hdIndex, (pk) => signDigest(digest, pk));
        const v = sig.yParity + 27;
        const signature = `${sig.r}${sig.s.slice(2)}${v.toString(16).padStart(2, '0')}` as Hex;
        return { kind: 'evm-personal', signerKind: this.kind, signature };
      }
    }
  }
}

function signDigest(digest: Uint8Array, privateKey: Uint8Array): { r: Hex; s: Hex; yParity: 0 | 1 } {
  // RFC 6979 deterministic nonce, low-S (canonical for Ethereum).
  const raw = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: 'recovered' });
  const sig = secp256k1.Signature.fromBytes(raw, 'recovered');
  const recovery = sig.recovery;
  if (recovery !== 0 && recovery !== 1) throw new SignerError('INVALID_PAYLOAD', 'Unexpected recovery id');
  return {
    r: toHex(numberTo32Bytes(sig.r)),
    s: toHex(numberTo32Bytes(sig.s)),
    yParity: recovery,
  };
}

function numberTo32Bytes(n: bigint): Uint8Array {
  return fromHex(n.toString(16).padStart(64, '0'));
}
