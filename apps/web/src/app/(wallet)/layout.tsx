import { AppShell } from '@/components/wallet/app-shell';

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
