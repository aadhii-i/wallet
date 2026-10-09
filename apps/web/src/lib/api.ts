'use client';
import { ApiClient, generateDeviceKeyPair, webCryptoDeviceKey, type DeviceKey } from '@qd/rpc';
import { openKv } from './idb';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

const deviceDb = openKv('qd-device');

/** Loads or creates this browser's non-extractable device key (spec §22). */
async function loadDeviceKey(): Promise<{ key: DeviceKey; fresh: boolean }> {
  let pair = await deviceDb.get<CryptoKeyPair>('deviceKey');
  const fresh = !pair;
  if (!pair) {
    pair = await generateDeviceKeyPair();
    await deviceDb.set('deviceKey', pair);
  }
  return { key: webCryptoDeviceKey(pair), fresh };
}

let clientPromise: Promise<ApiClient> | undefined;

export function getApi(): Promise<ApiClient> {
  clientPromise ??= loadDeviceKey().then(
    ({ key: deviceKey, fresh }) =>
      new ApiClient({
        baseUrl: API_URL,
        clientType: 'web',
        platform: 'web',
        deviceKey,
        expectedOrigin: window.location.origin,
        deviceLabel: browserLabel(),
        freshDevice: fresh,
      }),
  );
  return clientPromise;
}

/**
 * Sign this device out server-side, then forget its key (used when wiping the wallet).
 * Without the server-side revoke, the refresh cookie would outlive the wallet and the
 * next wallet on this browser could attach to the previous user (audit finding 4).
 */
export async function forgetDevice(): Promise<void> {
  try {
    const api = await getApi();
    const deviceId = api.currentSession?.deviceId ?? (await api.ensureSession()).deviceId;
    await api.revokeDevice(deviceId).catch(() => undefined);
    await api.logout().catch(() => undefined);
  } catch {
    /* offline: the key is still destroyed locally; the session expires server-side */
  }
  await deviceDb.clear();
  clientPromise = undefined;
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}
