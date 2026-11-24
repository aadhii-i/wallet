import { validateHederaAccountId } from './hedera-api';
import { hbarDisplayToTinybars, tinybarsToHbarDisplay } from './hedera-transfer';

/**
 * Pure validation/presentation helpers for the Hedera HBAR send flow.
 *
 * Keeping these here (instead of inline in the component) makes the
 * recipient, amount and balance rules testable without a DOM, a KeyWorker or
 * a network. The component only decides when to call them.
 */

/**
 * Conservative reserve for the network fee, in tinybars (0.01 HBAR).
 *
 * The sender pays the transfer fee, so the balance must cover the amount plus
 * this reserve. It is deliberately larger than a typical CryptoTransfer fee;
 * the UI labels it as an estimate and never treats it as the exact charge.
 */
export const HBAR_TRANSFER_FEE_BUFFER_TINYBARS = 1_000_000n;

/** Human-readable label for the fee reserve shown on the review screen. */
export const HBAR_TRANSFER_FEE_LABEL = `~${tinybarsToHbarDisplay(HBAR_TRANSFER_FEE_BUFFER_TINYBARS).replace(/\.?0+$/, '')} HBAR`;

export interface HbarAmountAssessment {
  /** Parsed amount, present only when `error` is null. */
  tinybars?: bigint;
  error: string | null;
}

/**
 * Parses a user-entered HBAR amount (up to 8 decimal places).
 *
 * Accepts inputs the amount field itself permits while typing, such as `.5`
 * and `1.`, and normalizes them before parsing. Zero, negative, scientific
 * notation and sub-tinybar precision are rejected.
 */
export function parseHbarAmount(input: string): HbarAmountAssessment {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter an amount' };

  let normalized = trimmed;
  if (normalized.startsWith('.')) normalized = `0${normalized}`;
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);

  if (!/^\d+(\.\d{1,8})?$/.test(normalized)) {
    return { error: 'Enter a valid HBAR amount (up to 8 decimal places)' };
  }

  try {
    const tinybars = hbarDisplayToTinybars(normalized);
    if (tinybars <= 0n) return { error: 'Enter an amount greater than 0' };
    return { tinybars, error: null };
  } catch {
    return { error: 'Enter a valid HBAR amount (up to 8 decimal places)' };
  }
}

/**
 * Validates an amount against the sender's available balance.
 *
 * When no balance is available yet, only the amount format is checked; the
 * component must re-check with a fresh balance immediately before submission.
 */
export function assessHbarSendAmount(
  input: string,
  balanceTinybars?: bigint | null,
): HbarAmountAssessment {
  const parsed = parseHbarAmount(input);
  if (parsed.error !== null || parsed.tinybars === undefined) return parsed;

  if (balanceTinybars !== undefined && balanceTinybars !== null) {
    if (!canSpendHbar(parsed.tinybars, balanceTinybars)) {
      return {
        error: `Insufficient balance: ${tinybarsToHbarDisplay(balanceTinybars)} HBAR available, and ${HBAR_TRANSFER_FEE_LABEL} is reserved for the network fee.`,
      };
    }
  }

  return { tinybars: parsed.tinybars, error: null };
}

/** Returns true when `amountTinybars` plus the fee reserve fits in the balance. */
export function canSpendHbar(amountTinybars: bigint, balanceTinybars: bigint): boolean {
  return amountTinybars + HBAR_TRANSFER_FEE_BUFFER_TINYBARS <= balanceTinybars;
}

/**
 * Validates a recipient Account ID for the given sender.
 *
 * Returns `null` for an empty input (the field has not been filled yet), a
 * format error for malformed IDs, and a self-send error when the recipient is
 * the selected account itself.
 */
export function validateHederaRecipient(input: string, fromAccountId: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!validateHederaAccountId(trimmed)) {
    return 'Enter a valid Hedera Account ID (e.g. 0.0.12345)';
  }
  if (trimmed === fromAccountId) return 'Cannot send to your own account';
  return null;
}
