import { WalletError, isWalletError } from '@qd/blockchain';

/**
 * Converts raw RPC / library errors into user-friendly WalletErrors (spec §16.6).
 * `phase` matters: a timeout after broadcast means funds MAY have moved.
 */
export function mapError(err: unknown, phase: 'estimate' | 'sign' | 'broadcast' | 'track' = 'broadcast'): WalletError {
  if (isWalletError(err)) return err;
  const technical = redactTechnical(describe(err));
  const text = technical.toLowerCase();
  const code = (err as { code?: unknown })?.code;

  const make = (init: Omit<ConstructorParameters<typeof WalletError>[0], 'technical'>) =>
    new WalletError({ ...init, technical });

  if (code === 4001 || text.includes('user rejected') || text.includes('user denied')) {
    return make({
      code: 'USER_REJECTED',
      userTitle: 'Transaction cancelled',
      userMessage: 'You cancelled this transaction. Nothing was sent.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  if (text.includes('wallet is locked') || (err as { code?: string })?.code === 'LOCKED') {
    return make({
      code: 'WALLET_LOCKED',
      userTitle: 'Wallet locked',
      userMessage: 'Unlock your wallet to continue. Nothing was sent.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  if (text.includes('insufficient funds for gas') || text.includes('insufficient funds for intrinsic')) {
    return make({
      code: 'INSUFFICIENT_FUNDS_FOR_FEE',
      userTitle: 'Not enough for the network fee',
      userMessage: 'You need more of the network’s native token to pay the fee. Your funds have not been sent.',
      fundsMoved: 'no',
      retryable: false,
    });
  }
  if (text.includes('insufficient funds') || text.includes('exceeds balance') || text.includes('transfer amount exceeds')) {
    return make({
      code: 'INSUFFICIENT_FUNDS',
      userTitle: 'Insufficient balance',
      userMessage: 'Your balance is too low for this transaction. Your funds have not been sent.',
      fundsMoved: 'no',
      retryable: false,
    });
  }
  if (text.includes('nonce too low') || text.includes('nonce has already been used') || text.includes('already known')) {
    return make({
      code: 'NONCE_CONFLICT',
      userTitle: 'Transaction conflict',
      userMessage: 'Another transaction from this account went through first. Please review and try again.',
      fundsMoved: 'unknown',
      retryable: true,
    });
  }
  if (text.includes('replacement transaction underpriced')) {
    return make({
      code: 'REPLACEMENT_UNDERPRICED',
      userTitle: 'Fee too low to replace',
      userMessage: 'The new fee must be higher than the original transaction’s fee.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  if (text.includes('max fee per gas less than block base fee') || text.includes('fee cap less than block base fee') || text.includes('underpriced')) {
    return make({
      code: 'FEE_TOO_LOW',
      userTitle: 'Network fee too low',
      userMessage: 'Network fees went up. Update the fee and try again. Your funds have not been sent.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  if (text.includes('execution reverted') || text.includes('reverted')) {
    return make({
      code: phase === 'estimate' ? 'GAS_ESTIMATION_FAILED' : 'REVERTED',
      userTitle: 'Transaction could not be completed',
      userMessage: 'The network rejected this transaction. Your funds have not been sent.',
      fundsMoved: phase === 'track' ? 'yes' : 'no',
      retryable: true,
    });
  }
  if (code === 429 || text.includes('rate limit') || text.includes('too many requests')) {
    return make({
      code: 'RATE_LIMITED',
      userTitle: 'Too many requests',
      userMessage: 'Please wait a moment and try again.',
      fundsMoved: phase === 'broadcast' ? 'unknown' : 'no',
      retryable: phase !== 'broadcast',
    });
  }
  const isNetwork =
    text.includes('timeout') || text.includes('timed out') || text.includes('fetch failed') ||
    text.includes('failed to fetch') || text.includes('network') || text.includes('econn');
  if (isNetwork && phase === 'broadcast') {
    return make({
      code: 'BROADCAST_UNKNOWN',
      userTitle: 'We couldn’t confirm the transaction was received',
      userMessage: 'Check Activity before trying again, so you don’t send twice.',
      fundsMoved: 'unknown',
      // Retrying could double-send: deliberately not offered (spec §16.6).
      retryable: false,
    });
  }
  if (isNetwork) {
    return make({
      code: 'NETWORK_UNAVAILABLE',
      userTitle: 'Network unavailable',
      userMessage: 'We couldn’t reach the network. Your funds have not been sent.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  if (phase === 'sign') {
    return make({
      code: 'SIGNING_FAILED',
      userTitle: 'Couldn’t sign the transaction',
      userMessage: 'Nothing was sent. Please review the transaction and try again.',
      fundsMoved: 'no',
      retryable: true,
    });
  }
  return make({
    code: 'UNKNOWN',
    userTitle: 'Something went wrong',
    userMessage:
      phase === 'broadcast' ? 'Check Activity before trying again.' : 'Your funds have not been sent. Please try again.',
    fundsMoved: phase === 'broadcast' ? 'unknown' : 'no',
    retryable: phase !== 'broadcast',
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    for (let i = 0; cause && i < 3; i++) {
      if (cause instanceof Error) parts.push(cause.message);
      cause = (cause as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  return typeof err === 'string' ? err : JSON.stringify(err ?? 'unknown');
}

const HEX_BLOB = /0x[0-9a-fA-F]{200,}/g;
const API_KEY_IN_URL = /(https?:\/\/[^\s/]+\/)[^\s]*/g;

/** Strips raw tx blobs and URLs (which may embed provider keys) from technical text. */
export function redactTechnical(s: string): string {
  return s.replace(HEX_BLOB, '0x…').replace(API_KEY_IN_URL, '$1…').slice(0, 1000);
}
