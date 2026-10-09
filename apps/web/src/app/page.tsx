'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { refreshVaultStatus } from '@/lib/gate';
import { useSession } from '@/lib/store';
import { Spinner } from '@/components/ui/spinner';

export default function Index() {
  const status = useSession((s) => s.status);
  const router = useRouter();
  useEffect(() => {
    void refreshVaultStatus();
  }, []);
  useEffect(() => {
    if (status === 'no-vault') router.replace('/onboarding');
    else if (status === 'locked') router.replace('/unlock');
    else if (status === 'unlocked') router.replace('/home');
  }, [status, router]);
  return (
    <div className="flex min-h-dvh items-center justify-center text-primary">
      <Spinner size={28} />
    </div>
  );
}
