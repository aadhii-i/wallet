import { isKnownTokenContract } from '@qd/blockchain';

export type RiskSeverity = 'info' | 'warning' | 'block';

export type RiskCode =
  | 'SELF_SEND'
  | 'OWN_ACCOUNT'
  | 'FIRST_TIME_RECIPIENT'
  | 'ADDRESS_POISONING'
  | 'TOKEN_CONTRACT_RECIPIENT'
  | 'ZERO_ADDRESS'
  | 'HIGH_FEE'
  | 'FEE_EXCEEDS_AMOUNT'
  | 'NONCE_GAP'
  | 'NONCE_QUEUED';

export interface RiskFinding {
  code: RiskCode;
  severity: RiskSeverity;
  title: string;
  message: string;
  /** Warnings must be explicitly acknowledged before Confirm enables (spec §16.4). */
  requiresAck: boolean;
  /** For ADDRESS_POISONING: the address the recipient imitates. */
  lookalikeOf?: string;
}

export interface RecipientContext {
  networkId: string;
  from: string;
  to: string;
  /** The user's own accounts, keyed by lowercase address → display name. */
  ownAccounts: ReadonlyMap<string, string>;
  /** Addresses this account previously interacted with (sent to or saved as contacts). */
  knownAddresses: readonly string[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Same first-4 and last-4 hex characters but not identical (spec §16.2, threat T10). */
export function looksLike(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^0x/, '');
  const y = b.toLowerCase().replace(/^0x/, '');
  if (x === y || x.length !== y.length || x.length < 8) return false;
  return x.slice(0, 4) === y.slice(0, 4) && x.slice(-4) === y.slice(-4);
}

export function assessRecipient(ctx: RecipientContext): RiskFinding[] {
  const to = ctx.to.toLowerCase();
  const findings: RiskFinding[] = [];

  if (to === ZERO) {
    return [
      {
        code: 'ZERO_ADDRESS',
        severity: 'block',
        title: 'Invalid recipient',
        message: 'Funds sent to the zero address are destroyed.',
        requiresAck: false,
      },
    ];
  }
  if (isKnownTokenContract(ctx.networkId, to)) {
    return [
      {
        code: 'TOKEN_CONTRACT_RECIPIENT',
        severity: 'block',
        title: 'This is a token contract',
        message: 'Sending funds to a token contract address will almost certainly lose them.',
        requiresAck: false,
      },
    ];
  }
  if (to === ctx.from.toLowerCase()) {
    findings.push({
      code: 'SELF_SEND',
      severity: 'info',
      title: 'Sending to yourself',
      message: 'The recipient is the same account you are sending from.',
      requiresAck: false,
    });
    return findings;
  }
  const ownName = ctx.ownAccounts.get(to);
  if (ownName) {
    findings.push({
      code: 'OWN_ACCOUNT',
      severity: 'info',
      title: `Transfer to ${ownName}`,
      message: 'This is one of your accounts.',
      requiresAck: false,
    });
    return findings;
  }

  const known = new Set(ctx.knownAddresses.map((a) => a.toLowerCase()));
  const lookalike = [...known, ...ctx.ownAccounts.keys()].find((k) => looksLike(k, to));
  if (lookalike) {
    findings.push({
      code: 'ADDRESS_POISONING',
      severity: 'warning',
      title: 'Possible address scam',
      message:
        'This address looks like one you used before but is different. Scammers create lookalike addresses to trick you. Compare every character.',
      requiresAck: true,
      lookalikeOf: lookalike,
    });
  }
  if (!known.has(to)) {
    findings.push({
      code: 'FIRST_TIME_RECIPIENT',
      severity: 'info',
      title: 'New address',
      message: "You haven't sent to this address before. Double-check it.",
      requiresAck: false,
    });
  }
  return findings;
}

/**
 * Fee sanity (spec §11.4): guards against a malicious or broken RPC inflating fees.
 * `feeWarningNative` is in base units.
 */
export function assessFee(opts: {
  maxFee: bigint;
  feeWarningNative: bigint;
  amount: bigint;
  isNativeTransfer: boolean;
}): RiskFinding[] {
  const out: RiskFinding[] = [];
  if (opts.maxFee > opts.feeWarningNative) {
    out.push({
      code: 'HIGH_FEE',
      severity: 'warning',
      title: 'Unusually high network fee',
      message: 'The network fee is much higher than normal. You may want to wait or lower the fee.',
      requiresAck: true,
    });
  }
  if (opts.isNativeTransfer && opts.amount > 0n && opts.maxFee > opts.amount) {
    out.push({
      code: 'FEE_EXCEEDS_AMOUNT',
      severity: 'warning',
      title: 'Fee is higher than the amount',
      message: 'You would pay more in fees than you are sending.',
      requiresAck: true,
    });
  }
  return out;
}

export function blockingFindings(findings: readonly RiskFinding[]): RiskFinding[] {
  return findings.filter((f) => f.severity === 'block');
}

/**
 * Nonce anomalies (audit finding 7). A gap can mean an RPC is withholding an earlier
 * transaction that could later execute alongside this one, so it must be acknowledged.
 */
export function assessNonce(warnings: readonly string[]): RiskFinding[] {
  const out: RiskFinding[] = [];
  if (warnings.includes('NONCE_GAP')) {
    out.push({
      code: 'NONCE_GAP',
      severity: 'warning',
      title: 'An earlier transaction may be missing',
      message:
        'The network reports more transactions from this account than this device sent. If you are re-sending a stuck payment, both could go through. Check Activity first.',
      requiresAck: true,
    });
  }
  if (warnings.includes('NONCE_BEHIND_LOCAL')) {
    out.push({
      code: 'NONCE_QUEUED',
      severity: 'warning',
      title: 'Previous transaction still pending',
      message: 'This transaction will be processed after your pending one. If you meant to replace it, cancel instead.',
      requiresAck: true,
    });
  }
  return out;
}
