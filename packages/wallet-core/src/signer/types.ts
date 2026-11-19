export type ChainFamily = 'evm' | 'bitcoin' | 'monero' | 'hedera';
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
    }
  | {
      /**
       * Bitcoin PSBT (base64). `packages/bitcoin` builds it and re-parses it after
       * signing; the signer only needs the account key, so wallet-core stays free
       * of chain libraries.
       */
      kind: 'btc-psbt';
      network: 'mainnet' | 'testnet4';
      /** Address that owns the inputs; must belong to the selected account. */
      from: string;
      addressType: 'p2wpkh' | 'p2tr';
      /** Unsigned PSBT, base64. */
      psbt: string;
    }
  | {
      /** Hedera native HBAR transfer. The KeyWorker signs the serialized bytes. */
      kind: 'hedera-transfer';
      /** Hedera Testnet Account ID of the sender, e.g. '0.0.12345'. */
      fromAccountId: string;
      /** Hedera Testnet Account ID of the recipient. */
      toAccountId: string;
      /** Transfer amount in tinybars as a decimal string (avoids bigint serialisation issues). */
      amountTinybars: string;
      /** Serialised TransferTransaction bytes, Uint8Array base64-encoded, for the KeyWorker to sign. */
      transactionBytes: string;
    }
  | {
      /** Hedera AccountCreateTransaction. The KeyWorker signs the serialised bytes
       *  with the payer key (required) and optionally with the new account's
       *  derived wallet key (proof of intent). Neither key is cached or returned. */
      kind: 'hedera-account-create';
      /** Serialised AccountCreateTransaction bytes, base64-encoded, for the KeyWorker to sign. */
      transactionBytes: string;
      /** Hedera Testnet Account ID of the fee payer, e.g. '0.0.11427910'. */
      payerAccountId: string;
      /** Payer's raw private-key hex. Used only inside this signing call, then wiped. */
      payerPrivateKeyHex: string;
      /** HD index of the wallet account whose derived key may also sign. */
      walletHdIndex: number;
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
  | { kind: 'evm-personal'; signerKind: SignerKind; signature: Hex }
  | { kind: 'btc-psbt'; signerKind: SignerKind; /** Signed PSBT, base64. */ psbt: string }
  | { kind: 'hedera-transfer'; signerKind: SignerKind; /** Signed transaction bytes, base64. */ signedBytes: string }
  | { kind: 'hedera-account-create'; signerKind: SignerKind; /** Signed transaction bytes, base64. */ signedBytes: string };

export interface Signer {
  readonly kind: SignerKind;
  supports(chainFamily: ChainFamily): boolean;
  getAddress(account: AccountRef, chainFamily: ChainFamily): Promise<string>;
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
