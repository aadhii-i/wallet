'use client';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useToasts, type ToastKind } from '@/lib/store';
import { Spinner } from './spinner';
import { t } from './motion';

const icon: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={20} className="text-success" />,
  error: <XCircle size={20} className="text-danger" />,
  info: <Info size={20} className="text-primary" />,
  pending: <Spinner size={18} className="text-primary" />,
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(80px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6"
      aria-live="polite"
      role="status"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            layout
            type="button"
            onClick={() => dismiss(toast.id)}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: t.exit }}
            transition={t.snappy}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-elevated px-4 py-3 text-left shadow-xl"
            {...(toast.kind === 'error' ? { 'aria-live': 'assertive' as const } : {})}
          >
            <span className="mt-0.5 shrink-0">{icon[toast.kind]}</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{toast.title}</span>
              {toast.description && <span className="mt-0.5 block text-sm text-muted">{toast.description}</span>}
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
