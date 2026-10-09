'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from './motion';

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return desktop;
}

/**
 * Bottom sheet on mobile (drag to dismiss), centered modal on desktop.
 * Radix provides focus trap, Esc handling and aria wiring.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  dismissible?: boolean;
}) {
  const desktop = useIsDesktop();
  const drag = useDragControls();
  const close = () => dismissible && onOpenChange(false);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o || dismissible) && onOpenChange(o)}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-[var(--qd-overlay)] backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: t.exit }}
                transition={t.fast}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
              onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
              {...(description ? {} : { 'aria-describedby': undefined })}
            >
              <motion.div
                className={
                  desktop
                    ? 'fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-3xl border border-line bg-elevated shadow-2xl'
                    : 'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-3xl border-t border-line bg-elevated pb-[env(safe-area-inset-bottom)] shadow-2xl'
                }
                style={desktop ? { x: '-50%', y: '-50%' } : undefined}
                initial={desktop ? { opacity: 0, scale: 0.96 } : { y: '100%' }}
                animate={desktop ? { opacity: 1, scale: 1 } : { y: 0 }}
                exit={desktop ? { opacity: 0, scale: 0.97, transition: t.exit } : { y: '100%', transition: t.exit }}
                transition={desktop ? t.base : t.sheet}
                {...(!desktop && dismissible
                  ? {
                      drag: 'y' as const,
                      dragControls: drag,
                      dragListener: false,
                      dragConstraints: { top: 0, bottom: 0 },
                      dragElastic: { top: 0, bottom: 0.6 },
                      onDragEnd: (_: unknown, info: { offset: { y: number }; velocity: { y: number } }) => {
                        if (info.offset.y > 120 || info.velocity.y > 600) close();
                      },
                    }
                  : {})}
              >
                {!desktop && (
                  <div className="flex touch-none justify-center pb-1 pt-3" onPointerDown={(e) => drag.start(e)}>
                    <div className="h-1.5 w-10 rounded-full bg-line-strong" />
                  </div>
                )}
                <div className="flex items-center justify-between px-5 pb-3 pt-3 sm:pt-5">
                  <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
                  {dismissible && (
                    <Dialog.Close className="-mr-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-ink" aria-label="Close">
                      <X size={20} />
                    </Dialog.Close>
                  )}
                </div>
                {description && <Dialog.Description className="-mt-2 px-5 pb-3 text-sm text-muted">{description}</Dialog.Description>}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
                {footer && <div className="border-t border-line px-5 py-4">{footer}</div>}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
