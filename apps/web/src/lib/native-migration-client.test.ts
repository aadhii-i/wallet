import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import {
  nativeMigrationFields,
  nativeMigrationApprovalMessage,
  type NativeMigration,
  type NativeMigrationManifest,
} from '@qd/rpc';
import { bytesToHex } from '@qd/wallet-core';
import { verifyMigration } from './native-migration-client';
const fixture = new URL('../../../../docs/api/native-migration-review-fixture.json', import.meta.url);
const digest = async (manifest: NativeMigrationManifest) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(nativeMigrationFields(manifest)))),
    ),
  );
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');
async function draft(): Promise<NativeMigration> {
  const review = JSON.parse(await readFile(fixture, 'utf8'));
  return {
    ...review,
    status: 'draft',
    revision: 1,
    approvals: [],
    attempts: [],
    progress: [],
    reviewPending: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
describe('native migration review verification', () => {
  it('rebuilds policies, destinations and coin commitments before approval', async () => {
    const m = await draft();
    await expect(verifyMigration(m)).resolves.toBeUndefined();
    const changed = structuredClone(m);
    changed.manifest.intents[0]!.bitcoinCoins![0]!.value = '1';
    await expect(verifyMigration(changed)).rejects.toThrow(/commitment/);
    changed.digest = await digest(changed.manifest);
    changed.manifest.intents[0]!.destination = 'attacker';
    changed.digest = await digest(changed.manifest);
    await expect(verifyMigration(changed)).rejects.toThrow(/destination/);
    const weak = structuredClone(m);
    weak.manifest.requiredApprovals = 1;
    weak.digest = await digest(weak.manifest);
    await expect(verifyMigration(weak)).rejects.toThrow(/confirm/);
  });
  it('requires real distinct device signatures from both groups and binds revised coin scope', async () => {
    const m = await draft();
    const keys: Record<string, CryptoKey> = {};
    for (const roster of [m.manifest.sourceRoster, m.manifest.targetRoster])
      for (const member of roster) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        keys[member.id] = pair.privateKey;
        member.deviceKey = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
      }
    m.digest = await digest(m.manifest);
    const approve = async (side: 'source' | 'target', index: number) => {
      const member = (side === 'source' ? m.manifest.sourceRoster : m.manifest.targetRoster)[index]!;
      m.approvals.push({
        side,
        participantId: member.id,
        at: new Date().toISOString(),
        signature: b64(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys[member.id]!,
            new TextEncoder().encode(nativeMigrationApprovalMessage(m, side)),
          ),
        ),
      });
    };
    await approve('source', 0);
    await approve('source', 1);
    m.status = 'frozen';
    await expect(verifyMigration(m)).rejects.toThrow(/confirm/);
    await approve('target', 0);
    await approve('target', 1);
    await expect(verifyMigration(m)).resolves.toBeUndefined();
    const duplicate = structuredClone(m);
    duplicate.approvals.push(duplicate.approvals[0]!);
    await expect(verifyMigration(duplicate)).rejects.toThrow(/participant/);
    m.manifest.intents[0]!.bitcoinCoins = [];
    m.digest = await digest(m.manifest);
    await expect(verifyMigration(m)).rejects.toThrow(/signature/);
  });
});
