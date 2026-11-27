import { Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { AppShell } from '@/components/wallet/app-shell';

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-primary">
          <Spinner size={28} />
        </div>
      }
    >
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
