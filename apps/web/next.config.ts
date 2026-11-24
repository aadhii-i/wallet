import type { NextConfig } from 'next';

/**
 * Static export (ADR-005): no server rendering of wallet pages. Security headers
 * (CSP, HSTS, …) are applied by the CDN in production — see
 * infrastructure/web/headers.json — and by `next dev` locally via `headers()`
 * (ignored by `output: 'export'`, which is why the CDN config is authoritative).
 */
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

const isDev = process.env.NODE_ENV !== 'production';

// Hedera Testnet transport endpoints used by @hashgraph/sdk's browser client:
//   - WebClient submits gRPC-web over HTTPS (fetch) to these seven fixed nodes.
//   - Mirror-node REST reads (receipts, balances) use the Testnet mirror host.
// There is no WebSocket transport. Origins are listed explicitly — no wildcards.
// Keep in sync with scripts/csp.mjs.
const hederaTestnetConnectSrc = [
  'https://testnet-node00-00-grpc.hedera.com',
  'https://testnet-node01-00-grpc.hedera.com',
  'https://testnet-node02-00-grpc.hedera.com',
  'https://testnet-node03-00-grpc.hedera.com',
  'https://testnet-node04-00-grpc.hedera.com',
  'https://testnet-node05-00-grpc.hedera.com',
  'https://testnet-node06-00-grpc.hedera.com',
  'https://testnet.mirrornode.hedera.com',
].join(' ');

const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; production CSP pins their hashes at deploy time.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // RPC traffic goes through the API proxy; custom RPCs are an explicit user setting.
  `connect-src 'self' ${apiOrigin} ${hederaTestnetConnectSrc} http://127.0.0.1:8545 http://localhost:8545${isDev ? ' ws://localhost:3000' : ''}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  transpilePackages: ['@qd/bitcoin', '@qd/blockchain', '@qd/evm', '@qd/qd-account', '@qd/qd-crypto', '@qd/rpc', '@qd/shared-types', '@qd/transaction', '@qd/ui', '@qd/wallet-core'],
  ...(isDev
    ? {
        async headers() {
          return [
            {
              source: '/:path*',
              headers: [
                { key: 'Content-Security-Policy', value: csp },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'no-referrer' },
                { key: 'X-Frame-Options', value: 'DENY' },
                { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=()' },
                { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
              ],
            },
          ];
        },
      }
    : {}),
};

export default config;
