'use client';
import { useRouter } from 'next/navigation';
import { AssetList } from '@/components/wallet/asset-list';
import { WalletHeader } from '@/components/wallet/header';
import { useValuedHoldings } from '@/lib/hooks';
import { useSelectedAccount } from '@/lib/store';

export default function AssetsPage() {
  const account = useSelectedAccount();
  const { holdings, valued } = useValuedHoldings(account?.address);
  const router = useRouter();
  return (
    <>
      <WalletHeader />
      <h1 className="mb-2 mt-4 text-2xl font-bold">Assets</h1>
      <AssetList
        valued={valued}
        loading={holdings.isLoading}
        error={holdings.isError}
        onRetry={() => void holdings.refetch()}
        onSelect={(h) => router.push(`/send?asset=${encodeURIComponent(h.asset.id)}`)}
      />
    </>
  );
}
