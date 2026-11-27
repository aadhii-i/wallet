/** Saving a share backup file in the browser. */

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "<wallet name> <YYYY-MM-DD>.json", safe as a file name on every OS. */
export function backupFileName(walletName: string, now = new Date()): string {
  // eslint-disable-next-line no-control-regex
  const name = walletName.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 60).trim() || 'Shared wallet';
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${name} ${date}.json`;
}
