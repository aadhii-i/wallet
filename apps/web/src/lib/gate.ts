'use client';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { vault } from './vault-client';
import { useMeta, useSession } from './store';

export async function refreshVaultStatus(): Promise<void> {
  const s = await vault.call('status');
  useSession.getState().set({
    status: !s.hasVault ? 'no-vault' : s.unlocked ? 'unlocked' : 'locked',
    backedUp: s.backedUp,
  });
}

/**
 * Routes the user to the right place for the current vault state.
 * `need` is the state this page requires.
 */
export function useVaultGate(need: 'unlocked' | 'no-vault' | 'locked' | 'no-vault-or-unlocked') {
  const status = useSession((s) => s.status);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    void refreshVaultStatus();
    const off = vault.onAutoLock(() => useSession.getState().set({ status: 'locked' }));
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (status === 'unknown') return;
    const ok =
      need === status ||
      (need === 'no-vault-or-unlocked' && (status === 'no-vault' || status === 'unlocked'));
    if (ok) return;
    if (status === 'no-vault') router.replace('/onboarding');
    else if (status === 'locked') router.replace(`/unlock?next=${encodeURIComponent(path)}`);
    else router.replace('/home');
  }, [status, need, router, path]);

  const ready =
    status === need || (need === 'no-vault-or-unlocked' && (status === 'no-vault' || status === 'unlocked'));
  return { status, ready };
}

/** Re-arms the worker auto-lock timer while the user is active (throttled). */
export function useActivityKeepAlive() {
  const minutes = useMeta((s) => s.autoLockMinutes);
  const status = useSession((s) => s.status);
  useEffect(() => {
    if (status !== 'unlocked') return;
    let last = 0;
    const arm = () => {
      const now = Date.now();
      if (now - last < 30_000) return;
      last = now;
      void vault.call('setAutoLock', { minutes }).catch(() => undefined);
    };
    arm();
    const events = ['pointerdown', 'keydown', 'scroll', 'visibilitychange'] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, arm));
  }, [minutes, status]);
}
