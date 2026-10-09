'use client';
import { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { ShieldAlert } from 'lucide-react';
import { WalletHeader } from '@/components/wallet/header';
import { ActionRow, BalanceHero, Tabs } from '@/components/wallet/balance';
import { AssetList } from '@/components/wallet/asset-list';
import { ActivityList } from '@/components/wallet/activity-list';
import { ReceiveSheet } from '@/components/wallet/receive-sheet';
import { useActivity, useNetwork, useValuedHoldings } from '@/lib/hooks';
import { useSelectedAccount, useSession } from '@/lib/store';
import { t } from '@/components/ui/motion';

export default function HomePage() {
  const account = useSelectedAccount();
  const network = useNetwork();
  const { holdings, valued, totalCents } = useValuedHoldings(account?.address);
  const activity = useActivity(account);
  const [tab, setTab] = useState<'tokens' | 'activity'>('tokens');
  const [receive, setReceive] = useState(false);
  const backedUp = useSession((s) => s.backedUp);

  return (
    <>
      <WalletHeader />
      <AnimatePresence>
        {!backedUp && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={t.base}>
            <Link href="/onboarding/backup" className="mt-2 flex items-center gap-3 rounded-2xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
              <ShieldAlert size={20} className="shrink-0 text-warning" />
              <span>
                <strong>Back up your wallet.</strong> Without your recovery phrase you could lose access to your funds.
              </span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div key={`${account?.index}-${network.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={t.base}>
        <BalanceHero
          valued={valued}
          totalCents={totalCents}
          loading={holdings.isLoading}
          error={holdings.isError}
          fetching={holdings.isFetching}
          onRefresh={() => void holdings.refetch()}
          network={network}
          address={account?.address}
        />
      </motion.div>
      <ActionRow onReceive={() => setReceive(true)} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'tokens', label: 'Tokens' },
          { value: 'activity', label: 'Activity' },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, x: tab === 'tokens' ? -12 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={t.fast}>
          {tab === 'tokens' ? (
            <AssetList valued={valued} loading={holdings.isLoading} error={holdings.isError} onRetry={() => void holdings.refetch()} />
          ) : (
            <ActivityList items={activity.items} loading={activity.isLoading} network={network} />
          )}
        </motion.div>
      </AnimatePresence>
      <ReceiveSheet open={receive} onOpenChange={setReceive} />
    </>
  );
}
