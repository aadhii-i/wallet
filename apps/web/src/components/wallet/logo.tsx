/** Placeholder typographic "QD" mark (Appendix A.2) — original, not derived from any brand. */
export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="qd-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2DDBC8" />
            <stop offset="100%" stopColor="#7C5CFF" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#qd-logo)" />
        <circle cx="13.5" cy="15" r="6" fill="none" stroke="#070B14" strokeWidth="3" />
        <path d="M17 18.5l4.5 4.5" stroke="#070B14" strokeWidth="3" strokeLinecap="round" />
        <path d="M22 9v8" stroke="#070B14" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      </svg>
      {withText && <span className="text-[17px] font-bold tracking-tight">QD Wallet</span>}
    </span>
  );
}
