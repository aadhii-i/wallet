'use client';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import QRCode from 'qrcode';
import { ExternalLink, Share2 } from 'lucide-react';
import { useNetwork } from '@/lib/hooks';
import { useSelectedAccount, toast } from '@/lib/store';
import { Button } from '../ui/button';
import { ChunkedAddress, CopyButton, Identicon } from '../ui/identity';
import { Sheet } from '../ui/sheet';
import { Skeleton } from '../ui/spinner';
import { t } from '../ui/motion';

export function ReceiveSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useSelectedAccount();
  const network = useNetwork();
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !account) return;
    setQr(null);
    // Plain address (not an EIP-681 URI) scans correctly in every wallet.
    QRCode.toDataURL(account.address, { margin: 1, width: 440, errorCorrectionLevel: 'M', color: { dark: '#070B14', light: '#FFFFFF' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [open, account]);

  if (!account) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Receive on ${network.name}`}>
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex items-center gap-2">
          <Identicon address={account.address} size={24} />
          <span className="font-semibold">{account.name}</span>
        </div>
        <div className="relative mb-4 h-56 w-56 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-line">
          {qr ? (
            <motion.img initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={t.base} src={qr} alt={`QR code for ${account.address}`} className="h-full w-full" />
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
        <div className="mb-3 flex w-full items-center gap-1 rounded-2xl bg-sunken px-4 py-3 text-left">
          <ChunkedAddress address={account.address} className="min-w-0 flex-1" />
          <CopyButton value={account.address} />
        </div>
        <p className="mb-4 rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-ink">
          Only send <strong>{network.name}</strong> assets to this address. Assets sent from other networks may be lost.
        </p>
        {network.faucetUrl && (
          <div className="mb-4 w-full rounded-xl bg-primary-soft px-3 py-2 text-left text-[13px] text-ink">
            <p className="mb-1 font-semibold">Need free test {network.nativeCurrency.symbol}?</p>
            <p>
              Copy the address above, paste it into the{' '}
              <a href={network.faucetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                {network.shortName} faucet <ExternalLink size={12} />
              </a>{' '}
              and request funds. Test funds have no real value. Your balance updates automatically once they arrive.
            </p>
          </div>
        )}
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <Button
            variant="secondary"
            block
            onClick={() => navigator.share({ text: account.address }).catch(() => toast.info('Sharing cancelled'))}
          >
            <Share2 size={18} /> Share address
          </Button>
        )}
      </div>
    </Sheet>
  );
}
