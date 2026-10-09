import {
  generateMnemonic as scureGenerate,
  validateMnemonic as scureValidate,
  mnemonicToSeed,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;
export const VALID_WORD_COUNTS = [12, 15, 18, 21, 24] as const;

/** Generates a BIP-39 English mnemonic from the platform CSPRNG. */
export function generateMnemonic(strength: MnemonicStrength = 128): string {
  return scureGenerate(wordlist, strength);
}

/** Collapses whitespace and lowercases; does not alter words. */
export function normalizeMnemonic(input: string): string {
  return input.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

export type MnemonicValidation =
  | { ok: true; words: number }
  | { ok: false; reason: 'word_count' | 'unknown_words' | 'checksum'; unknownIndexes?: number[] };

/** Local-only validation. The phrase never leaves the device (spec §9.5). */
export function validateMnemonic(input: string): MnemonicValidation {
  const phrase = normalizeMnemonic(input);
  const words = phrase.length === 0 ? [] : phrase.split(' ');
  if (!(VALID_WORD_COUNTS as readonly number[]).includes(words.length)) {
    return { ok: false, reason: 'word_count' };
  }
  const unknownIndexes = words.flatMap((w, i) => (isBip39Word(w) ? [] : [i]));
  if (unknownIndexes.length > 0) return { ok: false, reason: 'unknown_words', unknownIndexes };
  if (!scureValidate(phrase, wordlist)) return { ok: false, reason: 'checksum' };
  return { ok: true, words: words.length };
}

const WORDSET = new Set(wordlist);
export function isBip39Word(word: string): boolean {
  return WORDSET.has(word);
}

/** Autocomplete for the import grid. Returns at most `limit` words. */
export function suggestWords(prefix: string, limit = 4): string[] {
  const p = prefix.trim().toLowerCase();
  if (p.length === 0) return [];
  const out: string[] = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function mnemonicToSeedBytes(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return mnemonicToSeed(normalizeMnemonic(mnemonic), passphrase);
}

/** Picks `count` distinct random positions for the backup verification step. */
export function pickVerificationIndexes(wordCount: number, count = 3): number[] {
  const picked = new Set<number>();
  const buf = new Uint32Array(1);
  while (picked.size < Math.min(count, wordCount)) {
    crypto.getRandomValues(buf);
    picked.add(buf[0]! % wordCount);
  }
  return [...picked].sort((a, b) => a - b);
}

export { wordlist as bip39EnglishWordlist };
