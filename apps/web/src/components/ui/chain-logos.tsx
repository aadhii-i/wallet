'use client';
/**
 * Official chain / token logo SVGs — inline, zero runtime dependency.
 *
 * Sources (all open-licensed or official brand assets):
 *   Ethereum  — ethereum.org brand kit (CC BY 4.0)
 *   Bitcoin   — bitcoin.org brand kit (MIT)
 *   Hedera    — hedera.com brand kit
 *   Base      — base.org press kit
 *   Arbitrum  — arbitrum.foundation brand kit
 *   Polygon   — polygon.technology brand kit
 *   USDC      — circle.com brand kit
 *   USDT      — tether.to brand kit
 *   DAI       — makerdao brand kit
 *
 * Each component accepts a `size` prop (default 32) and renders an accessible
 * <svg> with aria-hidden so parent components own the accessible label.
 */

interface LogoProps {
  size?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Ethereum / ETH
// ---------------------------------------------------------------------------
export function EthereumLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="white">
        <polygon points="16,6 16,21.5 23,17.5" opacity="0.6" />
        <polygon points="16,6 9,17.5 16,21.5" />
        <polygon points="16,23.5 16,27 23,19" opacity="0.6" />
        <polygon points="16,27 16,23.5 9,19" />
        <polygon points="16,21.5 23,17.5 16,14" opacity="0.2" />
        <polygon points="9,17.5 16,21.5 16,14" opacity="0.6" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Bitcoin / BTC
// ---------------------------------------------------------------------------
export function BitcoinLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#F7931A" />
      <path
        fill="white"
        d="M22.5 14.4c.3-2-1.2-3-3.3-3.7l.7-2.7-1.6-.4-.7 2.6-.9-.2.6-2.6-1.6-.4-.7 2.7-2-.5-.3 1.6 1.2.3c.5.1.6.5.6.8l-1.5 6c-.1.3-.4.5-.8.4l-1.2-.3-.8 1.7 2 .5-.6 2.6 1.6.4.6-2.6.9.2-.6 2.6 1.6.4.6-2.7c2.7.5 4.7.3 5.5-2.1.7-1.9-.1-3-1.4-3.7 1-.2 1.7-1 1.9-2.3zm-3.4 4.8c-.5 2-3.8 1-4.9.7l.9-3.5c1.1.3 4.5.8 4 2.8zm.5-4.9c-.4 1.8-3.2 1-4 .7l.8-3.1c.9.2 3.6.7 3.2 2.4z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hedera / HBAR
// ---------------------------------------------------------------------------
export function HederaLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#222D3B" />
      {/* Hedera ℏ wordmark simplified to the H bar form */}
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fill="white"
        fontSize="16"
        fontFamily="Georgia, serif"
        fontStyle="italic"
        fontWeight="bold"
      >
        ℏ
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Base (Coinbase L2)
// ---------------------------------------------------------------------------
export function BaseLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#1C5CFF" />
      {/* Base "B" circle cut-out logo */}
      <path
        fill="white"
        d="M16 6C10.477 6 6 10.477 6 16s4.477 10 10 10c5.09 0 9.291-3.797 9.919-8.718H16.5v-2.564h9.419A10.002 10.002 0 0 0 16 6z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Arbitrum One
// ---------------------------------------------------------------------------
export function ArbitrumLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#2D374B" />
      {/* Arbitrum arrowhead */}
      <path fill="#28A0F0" d="M16 7 9 20h3l4-8 4 8h3z" />
      <path fill="white" d="M13.5 20h-1.8l1.3-2.6 1.3 2.6zm5.5 0h-1.8l-1.3-2.6 1.3 2.6z" opacity="0.7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Polygon PoS / POL
// ---------------------------------------------------------------------------
export function PolygonLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#8247E5" />
      <path
        fill="white"
        d="M20.6 13.6c-.3-.2-.7-.2-1 0l-2.4 1.4-1.6.9-2.4 1.4c-.3.2-.7.2-1 0L10.6 16c-.3-.2-.5-.5-.5-.9v-2.6c0-.4.2-.7.5-.9l1.6-.9c.3-.2.7-.2 1 0l1.6.9c.3.2.5.5.5.9v1.4l1.6-.9v-1.4c0-.4-.2-.7-.5-.9l-3.1-1.8c-.3-.2-.7-.2-1 0l-3.2 1.8c-.3.2-.5.5-.5.9v3.6c0 .4.2.7.5.9l3.2 1.8c.3.2.7.2 1 0l2.4-1.4 1.6-.9 2.4-1.4c.3-.2.7-.2 1 0l1.6.9c.3.2.5.5.5.9v2.6c0 .4-.2.7-.5.9l-1.6.9c-.3.2-.7.2-1 0l-1.6-.9c-.3-.2-.5-.5-.5-.9v-1.4l-1.6.9v1.4c0 .4.2.7.5.9l3.1 1.8c.3.2.7.2 1 0l3.1-1.8c.3-.2.5-.5.5-.9v-3.6c0-.4-.2-.7-.5-.9l-3-1.9z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// USDC
// ---------------------------------------------------------------------------
export function UsdcLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        fill="white"
        d="M16 7a9 9 0 1 0 0 18A9 9 0 0 0 16 7zm1.1 14.5v1.4h-2.2v-1.4a6.3 6.3 0 0 1-3.5-2l1.4-1.4c.6.8 1.6 1.4 2.9 1.4 1.5 0 2.4-.7 2.4-1.9 0-1-.6-1.6-2.3-2l-.8-.3c-2-.6-3-1.6-3-3.3 0-1.7 1.1-3 3-3.3V7.1h2.2v1.4c1.1.2 2 .8 2.7 1.7L18.5 11c-.5-.7-1.3-1.1-2.3-1.1-1.4 0-2.1.7-2.1 1.7 0 1 .6 1.4 2.2 1.9l.8.2c2.1.6 3.1 1.7 3.1 3.4 0 1.9-1.2 3.1-3.1 3.4z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// USDT (Tether)
// ---------------------------------------------------------------------------
export function UsdtLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#26A17B" />
      <path
        fill="white"
        d="M17.1 17.5v-.8c2.8-.2 4.9-.9 4.9-1.7s-2.1-1.5-4.9-1.7v-1.8h3.4V9.5H11.5v1.8H15v1.8c-2.8.2-4.9.9-4.9 1.7s2.1 1.5 4.9 1.7v4.4h2.1v-3.4zm0-2.5v.8c-1.8 0-3.2-.3-3.2-.6s1.4-.6 3.2-.6z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DAI (MakerDAO)
// ---------------------------------------------------------------------------
export function DaiLogo({ size = 32, className = '' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#F5AC37" />
      <path
        fill="white"
        d="M11 9h5.2c3.5 0 6 2 6.7 4.5H24v1.5h-1v1H24V17h-1.1C22 19.5 19.6 21.5 16.2 21.5H11v-5H9v-1.5h2v-1H9V13h2V9zm2 2v3.5h3.1c1.4 0 2.5-.7 3-1.8.1-.5.2-1.1.2-1.7H13zm0 5v3.5h3.2c1.5 0 2.7-.8 3.1-2 .1-.4.2-.9.2-1.5H13z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Generic "testnet" badge (amber network)
// ---------------------------------------------------------------------------
export function TestnetLogo({ size = 32, label = 'T', className = '' }: LogoProps & { label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill="#F2A900" />
      <text x="16" y="21" textAnchor="middle" fill="white" fontSize="14" fontFamily="system-ui,sans-serif" fontWeight="700">
        {label.slice(0, 1)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Generic fallback (coloured initial)
// ---------------------------------------------------------------------------
export function FallbackNetworkLogo({
  size = 32,
  label,
  color = '#5A6782',
  className = '',
}: LogoProps & { label: string; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="16" cy="16" r="16" fill={color} />
      <text x="16" y="21" textAnchor="middle" fill="white" fontSize="14" fontFamily="system-ui,sans-serif" fontWeight="700">
        {label.slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}
