import type { WalletError } from '@qd/blockchain';

/**
 * Send-flow state machine (spec §16.1). Pure reducer: the UI renders `state`,
 * dispatches events, and performs side effects based on the resulting state.
 */
export type SendStatus =
  | 'draft'
  | 'estimating'
  | 'ready_for_review'
  | 'signing'
  | 'broadcasting'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'rejected'
  | 'error';

export interface SendState {
  status: SendStatus;
  txHash?: string;
  error?: WalletError;
  /** Unix ms of the last fee quote; stale quotes force re-estimation. */
  quotedAt?: number;
}

export type SendEvent =
  | { type: 'ESTIMATE' }
  | { type: 'ESTIMATED'; at: number }
  | { type: 'EDIT' }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'SIGNED' }
  | { type: 'BROADCAST_OK'; hash: string }
  | { type: 'TX_CONFIRMED' }
  | { type: 'TX_FAILED'; error: WalletError }
  | { type: 'ERROR'; error: WalletError }
  | { type: 'RESET' };

export const QUOTE_TTL_MS = 30_000;

export const initialSendState: SendState = { status: 'draft' };

export function sendReducer(state: SendState, event: SendEvent): SendState {
  switch (event.type) {
    case 'RESET':
      return initialSendState;
    case 'EDIT':
      return canEdit(state.status) ? { status: 'draft' } : state;
    case 'ESTIMATE':
      return state.status === 'draft' || state.status === 'ready_for_review' || state.status === 'error'
        ? { status: 'estimating' }
        : state;
    case 'ESTIMATED':
      return state.status === 'estimating' ? { status: 'ready_for_review', quotedAt: event.at } : state;
    case 'CONFIRM':
      return state.status === 'ready_for_review' ? { ...state, status: 'signing' } : state;
    case 'CANCEL':
      return state.status === 'ready_for_review' || state.status === 'signing' ? { status: 'rejected' } : state;
    case 'SIGNED':
      return state.status === 'signing' ? { ...state, status: 'broadcasting' } : state;
    case 'BROADCAST_OK':
      return state.status === 'broadcasting' ? { status: 'pending', txHash: event.hash } : state;
    case 'TX_CONFIRMED':
      return state.status === 'pending' ? { ...state, status: 'confirmed' } : state;
    case 'TX_FAILED':
      return state.status === 'pending' ? { ...state, status: 'failed', error: event.error } : state;
    case 'ERROR':
      if (state.status === 'pending' || state.status === 'confirmed') return state;
      return { ...state, status: 'error', error: event.error };
  }
}

function canEdit(s: SendStatus): boolean {
  return s === 'draft' || s === 'ready_for_review' || s === 'error' || s === 'rejected';
}

export function isQuoteStale(state: SendState, now: number): boolean {
  return state.quotedAt === undefined || now - state.quotedAt > QUOTE_TTL_MS;
}

/** True when leaving the screen could hide an in-flight send from the user. */
export function isInFlight(s: SendStatus): boolean {
  return s === 'signing' || s === 'broadcasting';
}
