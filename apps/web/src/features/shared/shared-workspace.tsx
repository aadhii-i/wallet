'use client';

import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import {
  SHARED_ASSETS,
  sharedAnchor,
  sharedLocation,
  type SharedAsset,
  type SharedLocation,
  type SharedView,
} from '@/lib/shared-navigation';

export function useSharedWorkspace() {
  const [location, setLocation] = useState<SharedLocation>({
    view: 'home',
    asset: 'evm',
  });
  useEffect(() => {
    const update = () => setLocation((previous) => sharedLocation(window.location.hash, previous));
    update();
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const heading =
        location.view === 'home'
          ? 'sw-overview-title'
          : location.view === 'people'
            ? 'sw-people-title'
            : location.view === 'setup'
              ? 'sw-setup-title'
              : 'sw-task-title';
      document.getElementById(heading)?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.view, location.asset]);
  return {
    ...location,
    go(view: SharedView, asset = location.asset) {
      setLocation({ view, asset });
      window.location.hash = sharedAnchor(view, asset);
    },
  };
}

/** Keep signing components mounted when moving between views. Hiding a panel
 * must not discard a pending review, a signing round or a saved transaction. */
export function SharedPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div hidden={!active}>{children}</div>;
}

export function SharedAssetPicker({ asset, onChange }: { asset: SharedAsset; onChange: (asset: SharedAsset) => void }) {
  return (
    <label className="mb-4 block text-sm font-medium">
      Choose asset
      <select
        className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
        value={asset}
        onChange={(e) => onChange(e.target.value as SharedAsset)}
      >
        {SHARED_ASSETS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SharedHome({ onOpen }: { onOpen: (view: SharedView, asset?: SharedAsset) => void }) {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3" aria-label="Shared wallet actions">
        <button
          type="button"
          onClick={() => onOpen('requests')}
          className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-primary px-3 text-sm font-semibold text-on-primary"
        >
          <ArrowUpRight size={18} aria-hidden="true" /> Request payment
        </button>
        <button
          type="button"
          onClick={() => onOpen('assets')}
          className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-primary-soft px-3 text-sm font-semibold text-primary"
        >
          <ArrowDownLeft size={18} aria-hidden="true" /> Receive
        </button>
      </div>
      <section aria-labelledby="shared-assets-title" className="mb-5">
        <h2 id="shared-assets-title" className="mb-3 font-semibold">
          Your assets
        </h2>
        <div className="divide-y divide-line rounded-2xl border border-line bg-surface px-4">
          {SHARED_ASSETS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen('assets', item.id)}
              className="flex min-h-20 w-full items-center gap-3 py-3 text-left"
              aria-label={`Open ${item.name}`}
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xl text-primary"
                aria-hidden="true"
              >
                {item.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{item.name}</span>
                <span className="block text-xs text-subtle">{item.network}</span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-subtle" aria-hidden="true" />
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-subtle">Choose an asset to check its balance and receiving details.</p>
      </section>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onOpen('people')}
          className="min-h-12 rounded-xl border border-line px-3 text-sm font-medium"
        >
          People & invitations
        </button>
        <button
          type="button"
          onClick={() => onOpen('setup')}
          className="min-h-12 rounded-xl border border-line px-3 text-sm font-medium"
        >
          Wallet setup
        </button>
      </div>
    </>
  );
}
