export type ChainFamily = 'evm' | 'monero';
export type SignerKind = 'hd' | 'mpc' | 'qd';
export type Hex = `0x${string}`;

/**
 * What a signer is asked to sign. Adapters produce these; signers never build them.
 * Keeping payloads byte-level keeps wallet-core free of chain libraries (spec §10.4).
 */
export type SigningPayload =
  | {
      kind: 'evm-transaction';
      chainId: number;
      /** Checksummed sender; the signer checks that it matches the derived account. */
      from: Hex;
      /** EIP-2718 typed tx serialized WITHOUT signature; its keccak256 is the signing hash. */
      serializedUnsigned: Hex;
    }
  | {
      kind: 'evm-personal-message';
      from: Hex;
      /** Raw message bytes (hex). EIP-191 prefix is applied by the signer. */
      message: Hex;
    };

export interface AccountRef {
  id: string;
  /** BIP-44 address index for HD accounts. */
  hdIndex: number;
}

/**
 * Single-use binding between an approved review screen and the exact payload
 * that gets signed (spec §10.3, threat T7).
 */
export interface ConfirmationToken {
  id: string;
  payloadHash: Hex;
  issuedAt: number;
}

export interface SigningRequest {
  account: AccountRef;
  payload: SigningPayload;
  confirmation: ConfirmationToken;
}

export type SignatureResult =
  | { kind: 'evm-ecdsa'; signerKind: SignerKind; r: Hex; s: Hex; yParity: 0 | 1 }
  | { kind: 'evm-personal'; signerKind: SignerKind; signature: Hex };

export interface Signer {
  readonly kind: SignerKind;
  supports(chainFamily: ChainFamily): boolean;
  getAddress(account: AccountRef, chainFamily: ChainFamily): Promise<Hex>;
  sign(request: SigningRequest): Promise<SignatureResult>;
}

export class SignerError extends Error {
  constructor(
    readonly code:
      | 'LOCKED'
      | 'UNSUPPORTED'
      | 'CONFIRMATION_MISSING'
      | 'CONFIRMATION_MISMATCH'
      | 'CONFIRMATION_EXPIRED'
      | 'CONFIRMATION_REUSED'
      | 'ACCOUNT_MISMATCH'
      | 'INVALID_PAYLOAD',
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}
