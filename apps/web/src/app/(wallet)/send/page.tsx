'use client';
import { Suspense } from 'react';
import { SendFlow } from '@/features/send/send-flow';

export default function SendPage() {
  return (
    <Suspense>
      <SendFlow />
    </Suspense>
  );
}
