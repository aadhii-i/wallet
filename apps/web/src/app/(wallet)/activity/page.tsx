'use client';
import { ActivityList } from '@/components/wallet/activity-list';
import { WalletHeader } from '@/components/wallet/header';
import { useActivity, useNetwork } from '@/lib/hooks';
import { useSelectedAccount } from '@/lib/store';

export default function ActivityPage() {
  const account = useSelectedAccount();
  const network = useNetwork();
  const activity = useActivity(account);
  return (
    <>
      <WalletHeader />
      <h1 className="mb-1 mt-4 text-2xl font-bold">Activity</h1>
      <ActivityList items={activity.items} loading={activity.isLoading} network={network} />
    </>
  );
}
