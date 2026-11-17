'use client';
import { Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { SharedWalletsScreen } from '@/features/shared/shared-wallets';

/**
 * Shared wallets (multi-participant approval). The selected wallet lives in the
 * query string (/shared?wallet=<id>) so the route stays statically exportable.
 * useSearchParams needs a Suspense boundary under static export.
 */
export default function SharedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12 text-primary">
          <Spinner size={24} />
        </div>
      }
    >
      <SharedWalletsScreen />
    </Suspense>
  );
}
