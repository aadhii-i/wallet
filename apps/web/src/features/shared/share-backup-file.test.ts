import { describe, expect, it } from 'vitest';
import { backupFileName } from './share-backup-file';

describe('backupFileName', () => {
  const day = new Date(2026, 10, 26, 23, 59); // local time, 26 Nov 2026

  it('is the wallet name and the local date', () => {
    expect(backupFileName('Family vault', day)).toBe('Family vault 2026-11-26.json');
    expect(backupFileName('Team', new Date(2027, 0, 5))).toBe('Team 2027-01-05.json');
  });

  it('removes characters that are not allowed in file names', () => {
    expect(backupFileName('a/b\\c:d*e?f"g<h>i|j', day)).toBe('a b c d e f g h i j 2026-11-26.json');
    expect(backupFileName('../../etc/passwd', day)).toBe('etc passwd 2026-11-26.json');
    expect(backupFileName('line\nbreak\ttab', day)).toBe('line break tab 2026-11-26.json');
  });

  it('falls back to a default name and caps the length', () => {
    expect(backupFileName('   ', day)).toBe('Shared wallet 2026-11-26.json');
    expect(backupFileName('...', day)).toBe('Shared wallet 2026-11-26.json');
    expect(backupFileName('x'.repeat(200), day)).toBe(`${'x'.repeat(60)} 2026-11-26.json`);
  });
});
