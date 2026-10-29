export type FundsMoved = 'no' | 'yes' | 'unknown';

export type WalletErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_FUNDS_FOR_FEE'
  | 'NONCE_CONFLICT'
  | 'REPLACEMENT_UNDERPRICED'
  | 'FEE_TOO_LOW'
  | 'REVERTED'
  | 'GAS_ESTIMATION_FAILED'
  | 'FEE_QUOTE_FAILED'
  | 'BROADCAST_UNKNOWN'
  | 'NETWORK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'USER_REJECTED'
  | 'SIGNING_FAILED'
  | 'WALLET_LOCKED'
  | 'CHAIN_MISMATCH'
  | 'UNKNOWN';

/**
 * User-facing error shape (spec §16.6). `technical` is shown only behind a
 * "Details" disclosure and must never contain secrets.
 */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly userTitle: string;
  readonly userMessage: string;
  readonly fundsMoved: FundsMoved;
  readonly retryable: boolean;
  readonly technical: string | undefined;

  constructor(init: {
    code: WalletErrorCode;
    userTitle: string;
    userMessage: string;
    fundsMoved: FundsMoved;
    retryable: boolean;
    technical?: string;
  }) {
    super(init.userMessage);
    this.name = 'WalletError';
    this.code = init.code;
    this.userTitle = init.userTitle;
    this.userMessage = init.userMessage;
    this.fundsMoved = init.fundsMoved;
    this.retryable = init.retryable;
    this.technical = init.technical;
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return e instanceof WalletError;
}
