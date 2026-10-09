'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Globe, Server, Timer, Trash2 } from 'lucide-react';
import { registry } from '@/lib/chains';
import { forgetDevice } from '@/lib/api';
import { toast, useMeta, useSession } from '@/lib/store';
import { reportEvent } from '@/lib/sync';
import { vault } from '@/lib/vault-client';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { NetworkDot } from '@/components/wallet/network-sheet';

const LOCK_OPTIONS = [1, 5, 15, 30, 60];

export default function SettingsPage() {
  const autoLock = useMeta((s) => s.autoLockMinutes);
  const setAutoLock = useMeta((s) => s.setAutoLockMinutes);
  const customRpc = useMeta((s) => s.customRpc);
  const [rpcSheet, setRpcSheet] = useState<string | null>(null);
  const [wipe, setWipe] = useState(false);

  return (
    <>
      <h1 className="mb-6 mt-2 text-2xl font-bold">Settings</h1>

      <Group title="General">
        <Row icon={<Globe size={18} />} label="Currency" value="USD" />
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="text-muted">
            <Timer size={18} />
          </span>
          <label htmlFor="autolock" className="flex-1 font-medium">
            Auto-lock after
          </label>
          <select
            id="autolock"
            value={autoLock}
            onChange={async (e) => {
              const m = Number(e.target.value);
              setAutoLock(m);
              await vault.call('setAutoLock', { minutes: m });
              toast.success(`Auto-lock set to ${m} minute${m > 1 ? 's' : ''}`);
            }}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
          >
            {LOCK_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </div>
      </Group>

      <Group title="Networks" hint="By default, QD Wallet reaches networks through its own servers so provider keys stay private. You can use your own RPC instead.">
        {registry.all().map((n) => (
          <button key={n.id} type="button" onClick={() => setRpcSheet(n.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-hover">
            <NetworkDot network={n} size={24} />
            <span className="flex-1">
              <span className="block font-medium">{n.name}</span>
              <span className="block truncate text-xs text-subtle">{customRpc[n.id] ? `Custom RPC · ${new URL(customRpc[n.id]!).host}` : 'QD Wallet RPC'}</span>
            </span>
            <ChevronRight size={18} className="text-subtle" />
          </button>
        ))}
      </Group>

      <Group title="About">
        <Row icon={<Server size={18} />} label="Version" value="0.1.0 (V1 preview)" />
      </Group>

      <Group title="Danger zone">
        <button type="button" onClick={() => setWipe(true)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-danger hover:bg-danger-soft">
          <Trash2 size={18} />
          <span className="font-medium">Remove wallet from this device</span>
        </button>
      </Group>

      <RpcSheet networkId={rpcSheet} onClose={() => setRpcSheet(null)} />
      <WipeSheet open={wipe} onOpenChange={setWipe} />
    </>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      {hint && <p className="mb-2 px-1 text-[13px] text-muted">{hint}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{children}</div>
    </section>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="text-muted">{icon}</span>
      <span className="flex-1 font-medium">{label}</span>
      <span className="text-sm text-muted">{value}</span>
    </div>
  );
}

function RpcSheet({ networkId, onClose }: { networkId: string | null; onClose: () => void }) {
  const network = networkId ? registry.byId(networkId) : undefined;
  const current = useMeta((s) => (networkId ? s.customRpc[networkId] : undefined));
  const setCustomRpc = useMeta((s) => s.setCustomRpc);
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!network) return;
    setBusy(true);
    setError(null);
    try {
      const u = new URL(url.trim());
      const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !isLocal) throw new Error('Use an https:// URL');
      // Verify the RPC serves the expected chain before trusting it (chain id never comes from RPC for signing).
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const j = (await res.json()) as { result?: string };
      if (!j.result || parseInt(j.result, 16) !== network.chainId) throw new Error(`This RPC is not for ${network.name} (chain ${network.chainId})`);
      setCustomRpc(network.id, u.toString());
      void qc.invalidateQueries();
      toast.success('Custom RPC saved');
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t reach this RPC');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!network} onOpenChange={(o) => !o && onClose()} title={network ? `${network.name} RPC` : ''} description="A custom RPC sees your addresses and IP. Only use one you trust.">
      <label htmlFor="rpc-url" className="mb-1.5 block text-sm font-medium">
        RPC URL
      </label>
      <input
        id="rpc-url"
        value={url}
        placeholder={current ?? 'https://…'}
        onChange={(e) => setUrl(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={`mb-1 h-12 w-full rounded-xl border bg-surface px-4 font-mono text-sm outline-none focus:border-primary ${error ? 'border-danger' : 'border-line-strong'}`}
      />
      <p className="mb-4 min-h-5 text-sm text-danger">{error}</p>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          disabled={!current}
          onClick={() => {
            if (!network) return;
            setCustomRpc(network.id, null);
            void qc.invalidateQueries();
            toast.info('Using QD Wallet RPC');
            onClose();
          }}
        >
          Use default
        </Button>
        <Button onClick={save} disabled={!url.trim()} loading={busy} loadingText="Checking…">
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function WipeSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Remove wallet?" description="The encrypted wallet will be deleted from this browser. You can only restore it with your recovery phrase.">
      <label htmlFor="wipe" className="mb-2 block text-sm">
        Type <strong>REMOVE</strong> to confirm
      </label>
      <input id="wipe" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="mb-4 h-12 w-full rounded-xl border border-line-strong bg-surface px-4 outline-none focus:border-primary" />
      <Button
        variant="danger"
        block
        size="lg"
        disabled={confirm !== 'REMOVE'}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await reportEvent('wallet_wiped');
          await forgetDevice();
          await vault.call('wipe');
          useMeta.getState().reset();
          useSession.getState().set({ status: 'no-vault', backedUp: true });
          router.replace('/onboarding');
        }}
      >
        Remove wallet
      </Button>
    </Sheet>
  );
}
