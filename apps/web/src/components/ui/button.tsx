'use client';
import { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { Spinner } from './spinner';
import { t } from './motion';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingText?: string;
  block?: boolean;
  children?: React.ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover shadow-[0_1px_0_rgba(255,255,255,0.15)_inset]',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-ink hover:bg-surface-hover',
  danger: 'bg-danger text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-[15px]',
  lg: 'h-13 px-6 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, loadingText, block, disabled, className = '', children, type = 'button', ...rest },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <motion.button
      ref={ref}
      type={type}
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      transition={t.instant}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`relative inline-flex select-none items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {loading ? (
        <>
          <Spinner size={16} />
          <span>{loadingText ?? children}</span>
        </>
      ) : (
        children
      )}
    </motion.button>
  );
});

export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: { label: string; children: React.ReactNode } & Omit<HTMLMotionProps<'button'>, 'children'>) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.92 }}
      transition={t.instant}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-ink ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
