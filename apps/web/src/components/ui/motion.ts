import { motion as tokens } from '@qd/ui';

const s = (ms: number) => ms / 1000;

/** Shared transitions so timing and easing stay consistent everywhere. */
export const t = {
  instant: { duration: s(tokens.duration.instant), ease: tokens.easing.standard },
  fast: { duration: s(tokens.duration.fast), ease: tokens.easing.standard },
  base: { duration: s(tokens.duration.base), ease: tokens.easing.standard },
  emphasis: { duration: s(tokens.duration.emphasis), ease: tokens.easing.emphasis },
  exit: { duration: s(tokens.duration.base * tokens.exitFactor), ease: tokens.easing.accelerate },
  sheet: tokens.spring.sheet,
  snappy: tokens.spring.snappy,
} as const;

/** Step transitions for multi-step flows: direction 1 = forward, -1 = back. */
export const stepVariants = {
  enter: (dir: number) => ({ x: dir * 32, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -32, opacity: 0 }),
};
