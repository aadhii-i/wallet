'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Pencil, Plus } from 'lucide-react';
import { formatDisplay } from '@qd/blockchain';
import { useQueryClient } from '@tanstack/react-query';
import { useAdapter } from '@/lib/hooks';
import { toast, useMeta, type AccountMeta } from '@/lib/store';
import { syncWithBackend } from '@/lib/sync';
import { vault } from '@/lib/vault-client';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Identicon, shortAddress } from '../ui/identity';
import { Sheet } from '../ui/sheet';
import { t } from '../ui/motion';

export function AccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const accounts = useMeta((s) => s.accounts);
  const selected = useMeta((s) => s.selectedIndex);
  const select = useMeta((s) => s.selectAccount);
  const addAccount = useMeta((s) => s.addAccount);
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();

  const onAdd = async () => {
    setAdding(true);
    try {
      const next = Math.max(-1, ...accounts.map((a) => a.index)) + 1;
      const [address] = await vault.call('addresses', { indexes: [next] });
      addAccount({ index: next, name: `Account ${next + 1}`, address: address! });
      toast.success(`Account ${next + 1} created`);
      void syncWithBackend();
      void qc.invalidateQueries({ queryKey: ['holdings'] });
    } catch {
      toast.error('Couldn’t create account', 'Unlock your wallet and try again.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Accounts"
      footer={
        <Button variant="secondary" block onClick={onAdd} loading={adding} loadingText="Creating account…">
          <Plus size={18} /> Add account
        </Button>
      }
    >
      <ul className="-mx-1">
        <AnimatePresence initial={false}>
          {accounts.filter((a) => !a.hidden).map((a) => (
            <motion.li key={a.index} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={t.base}>
              <AccountRow
                account={a}
                active={a.index === selected}
                onSelect={() => {
                  if (a.index !== selected) {
                    select(a.index);
                    toast.info(`Switched to ${a.name}`);
                  }
                  onOpenChange(false);
                }}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Sheet>
  );
}

function AccountRow({ account, active, onSelect }: { account: AccountMeta; active: boolean; onSelect: () => void }) {
  const rename = useMeta((s) => s.renameAccount);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const adapter = useAdapter();
  const bal = useQuery({
    queryKey: ['native', adapter.network.id, account.address],
    queryFn: () => adapter.getBalance(account.address),
    staleTime: 15_000,
  });

  const commit = () => {
    const trimmed = name.trim().slice(0, 32);
    if (trimmed && trimmed !== account.name) {
      rename(account.index, trimmed);
      toast.success('Account renamed');
    } else setName(account.name);
    setEditing(false);
  };

  return (
    <div className={`relative flex items-center gap-3 rounded-xl px-3 py-3 ${active ? 'bg-primary-soft' : 'hover:bg-surface-hover'}`}>
      {active && <span className="absolute bottom-2 left-0 top-2 w-1 rounded-full bg-primary" />}
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-current={active || undefined}>
        <Identicon address={account.address} size={36} />
        <span className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  setName(account.name);
                  setEditing(false);
                }
              }}
              aria-label="Account name"
              className="w-full rounded-lg border border-primary bg-surface px-2 py-1 text-[15px] font-medium outline-none"
            />
          ) : (
            <span className="block truncate font-medium">{account.name}</span>
          )}
          <span className="block font-mono text-xs text-subtle">{shortAddress(account.address)}</span>
        </span>
        <span className="tabular text-right text-sm text-muted">
          {bal.data !== undefined ? `${formatDisplay(bal.data, 18, 4)} ${adapter.network.nativeCurrency.symbol}` : <span className="skeleton inline-block h-4 w-16 rounded" />}
        </span>
      </button>
      {active && <Check size={18} className="shrink-0 text-primary" />}
      <button type="button" aria-label={`Rename ${account.name}`} onClick={() => setEditing(true)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-subtle hover:bg-surface hover:text-ink">
        <Pencil size={14} />
      </button>
    </div>
  );
}
