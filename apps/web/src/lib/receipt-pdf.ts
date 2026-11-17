/**
 * A small, dependency-free PDF 1.4 writer for the shared-wallet transaction
 * receipt: one A4 page, built-in Helvetica / Courier (WinAnsi), text, rules
 * and one clickable link annotation to the block explorer.
 *
 * The receipt is built only from data read back from the chain (see
 * `VerifiedReceipt`); this module never decides whether a transaction
 * succeeded.
 */

export interface VerifiedReceipt {
  status: 'Confirmed';
  txHash: string;
  explorerUrl: string;
  networkName: string; // e.g. "Sepolia Testnet"
  chainId: number;
  from: string; // sender (the shared smart account for executions)
  to: string; // recipient
  amountEth: string; // e.g. "0.02"
  symbol: string; // e.g. "ETH"
  blockNumber: number;
  blockTimestamp: string; // ISO 8601, from the block
  gasUsed: string;
  effectiveGasPriceWei: string;
  totalFeeEth: string;
  generatedAt: string; // ISO 8601
  /** Labels for the from/to rows (default: shared smart account → recipient). */
  fromLabel?: string;
  toLabel?: string;
  // Shared-wallet execution details (omitted for other transactions).
  txNonce?: number; // relayer transaction nonce
  accountNonce?: number; // QdAccount nonce consumed by this execution
  relayer?: string; // paid the gas
  feePayer?: string; // who paid the gas, when not a relayer
  policy?: string; // e.g. "2-of-3"
  signers?: string[]; // e.g. ["NENA (party 2)", "RAHIMAN (party 3)"]
  signatureVerification?: string;
  proposalId?: string;
}

export const RECEIPT_TITLE = 'QD Wallet — Sepolia Transaction Receipt';
export const RECEIPT_DISCLAIMER =
  'This is an application-generated transaction summary. The canonical transaction record is maintained by the Sepolia blockchain and can be independently verified using Etherscan.';

export function receiptTitle(networkName: string): string {
  return /sepolia/i.test(networkName) ? RECEIPT_TITLE : `QD Wallet — ${networkName} Transaction Receipt`;
}

export function receiptDisclaimer(networkName: string, explorerName: string): string {
  return /sepolia/i.test(networkName)
    ? RECEIPT_DISCLAIMER
    : `This is an application-generated transaction summary. The canonical transaction record is maintained by the ${networkName} blockchain and can be independently verified using ${explorerName}.`;
}

// ---- text encoding ---------------------------------------------------------------

/** WinAnsi bytes for the characters we use; others become '?'. */
function winAnsi(s: string): number[] {
  const special: Record<string, number> = { '—': 0x97, '–': 0x96, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, '·': 0xb7 };
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (special[ch] !== undefined) out.push(special[ch]!);
    else if (c >= 0x20 && c <= 0x7e) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(0x3f);
  }
  return out;
}

/** A PDF literal string: (…) with \, ( and ) escaped, bytes as octal escapes when non-ASCII. */
function pdfString(s: string): string {
  let out = '(';
  for (const b of winAnsi(s)) {
    if (b === 0x5c || b === 0x28 || b === 0x29) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

// Helvetica widths (1/1000 em) for ASCII 32..126, used for wrapping.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
function textWidth(s: string, size: number, mono: boolean): number {
  let w = 0;
  for (const b of winAnsi(s)) w += mono ? 600 : (HELV[b - 32] ?? 556);
  return (w * size) / 1000;
}

function wrap(s: string, size: number, maxWidth: number, mono: boolean): string[] {
  const lines: string[] = [];
  if (mono) {
    // Hashes and addresses: break anywhere.
    const per = Math.max(1, Math.floor(maxWidth / (0.6 * size)));
    for (let i = 0; i < s.length; i += per) lines.push(s.slice(i, i + per));
    return lines.length ? lines : [''];
  }
  let cur = '';
  for (const word of s.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, size, false) > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ---- document -------------------------------------------------------------------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;

export function buildReceiptPdf(r: VerifiedReceipt): Uint8Array {
  const ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const text = (s: string, x: number, size: number, font: 'F1' | 'F2' | 'F3', color = '0 0 0') =>
    ops.push(`BT /${font} ${size} Tf ${color} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  const rule = (gap = 10) => {
    y -= gap;
    ops.push(`0.85 0.87 0.9 RG 0.8 w ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
    y -= gap;
  };

  // Header: brand mark + title.
  ops.push(`0.09 0.36 0.85 rg ${MARGIN} ${(y - 22).toFixed(2)} 26 26 re f`);
  ops.push(`BT /F2 13 Tf 1 1 1 rg ${(MARGIN + 5.5).toFixed(2)} ${(y - 14.5).toFixed(2)} Td (QD) Tj ET`);
  y -= 6;
  text('QD Wallet', MARGIN + 36, 11, 'F2', '0.09 0.36 0.85');
  y -= 16;
  text(receiptTitle(r.networkName), MARGIN + 36, 15, 'F2');
  y -= 8;
  rule(10);
  // Status badge.
  ops.push(`0.86 0.97 0.9 rg ${MARGIN} ${(y - 6).toFixed(2)} 92 20 re f`);
  text(`Status: ${r.status}`, MARGIN + 8, 10, 'F2', '0.05 0.5 0.2');
  y -= 30;

  const labelW = 150;
  const valueX = MARGIN + labelW;
  const valueW = PAGE_W - MARGIN - valueX;
  let linkRect: [number, number, number, number] | null = null;
  const row = (label: string, value: string, mono = false, link = false) => {
    const size = mono ? 8.5 : 10;
    const lines = wrap(value, size, valueW, mono);
    text(label, MARGIN, 9, 'F1', '0.4 0.43 0.48');
    const top = y + size;
    lines.forEach((l, i) => {
      if (i > 0) y -= size + 3;
      text(l, valueX, size, mono ? 'F3' : 'F1', link ? '0.09 0.36 0.85' : '0 0 0');
    });
    if (link) linkRect = [valueX, y - 3, PAGE_W - MARGIN, top + 2];
    y -= 17;
  };

  row('Transaction hash', r.txHash, true);
  row('Etherscan', r.explorerUrl, true, true);
  row('Network', `${r.networkName} (chain ID ${r.chainId})`);
  row(r.fromLabel ?? 'From (shared smart account)', r.from, true);
  row(r.toLabel ?? 'To (recipient)', r.to, true);
  row('Amount', `${r.amountEth} ${r.symbol}`);
  rule(4);
  row('Block number', String(r.blockNumber));
  row('Block timestamp', `${r.blockTimestamp.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')} UTC`);
  if (r.txNonce !== undefined) row('Transaction nonce (relayer)', String(r.txNonce));
  if (r.accountNonce !== undefined) row('Account nonce (QdAccount)', String(r.accountNonce));
  row('Gas used', r.gasUsed);
  row('Effective gas price', `${r.effectiveGasPriceWei} wei`);
  row(r.relayer ? 'Total gas fee (paid by relayer)' : 'Total gas fee', `${r.totalFeeEth} ${r.symbol}`);
  if (r.relayer) row('Relayer (gas payer)', r.relayer, true);
  else if (r.feePayer) row('Gas paid by', r.feePayer, true);
  if (r.policy || r.signers || r.signatureVerification || r.proposalId) rule(4);
  if (r.policy) row('Threshold policy', r.policy);
  if (r.signers) row('Signing participants', r.signers.join(', '));
  if (r.signatureVerification) row('Threshold Raccoon signature', r.signatureVerification);
  if (r.proposalId) row('Proposal', r.proposalId, true);
  row('Receipt generated', `${r.generatedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')} UTC`);
  rule(6);
  for (const l of wrap(receiptDisclaimer(r.networkName, 'Etherscan'), 8.5, PAGE_W - 2 * MARGIN, false)) {
    text(l, MARGIN, 8.5, 'F1', '0.4 0.43 0.48');
    y -= 12;
  }

  const content = ops.join('\n');
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const annots = linkRect ? '/Annots [8 0 R]' : '';
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R ${annots} >>`;
  objects[4] = `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  if (linkRect) {
    const [x1, y1, x2, y2] = linkRect as [number, number, number, number];
    objects[8] = `<< /Type /Annot /Subtype /Link /Rect [${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(r.explorerUrl)} >> >>`;
  }
  const info = objects.length;
  objects[info] = `<< /Title ${pdfString(receiptTitle(r.networkName))} /Producer (QD Wallet) /Subject ${pdfString(`Transaction ${r.txHash}`)} >>`;

  // Content is ASCII (non-ASCII is octal-escaped), so string length = byte length.
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = byteLength(out);
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1Bytes(out);
}

function byteLength(s: string): number {
  return s.length; // every character is a single Latin-1 byte (see latin1Bytes)
}

function latin1Bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

export function receiptFileName(r: Pick<VerifiedReceipt, 'txHash' | 'chainId'>): string {
  return `qd-wallet-receipt-${r.chainId}-${r.txHash.slice(0, 12)}.pdf`;
}
