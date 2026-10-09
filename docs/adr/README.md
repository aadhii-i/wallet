# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-tooling-pnpm-turborepo-go-module.md) | Monorepo tooling: pnpm + Turborepo + Go module | Accepted |
| [0002](0002-client-side-transaction-construction-and-signing.md) | Client-side transaction construction and signing | Accepted |
| [0003](0003-viem-without-wagmi-inside-the-wallet.md) | Viem without Wagmi inside the wallet | Accepted |
| [0004](0004-web-vault-argon2id-aes-256-gcm-in-indexeddb-inside-a-web-worker.md) | Web vault: Argon2id + AES-256-GCM in IndexedDB, inside a Web Worker | Accepted |
| [0005](0005-hosted-static-web-app-with-hash-based-csp.md) | Hosted static web app with hash-based CSP | Accepted (residual risk) |
| [0006](0006-monero-via-client-side-wallet-monero-ts.md) | Monero via client-side wallet (monero-ts) | Proposed — M5 spike |
| [0007](0007-monero-key-derivation-from-the-bip-39-root.md) | Monero key derivation from the BIP-39 root | Proposed — M5 spike |
| [0008](0008-device-key-authentication-cookie-sessions-for-web.md) | Device-key authentication; cookie sessions for web | Accepted |
| [0009](0009-rpc-proxy-with-allowlist-and-provider-pool.md) | RPC proxy with allowlist and provider pool | Accepted |
| [0010](0010-metamask-compatible-evm-derivation-path.md) | MetaMask-compatible EVM derivation path | Accepted |
| [0011](0011-prices-fetched-by-the-backend-for-the-whole-token-list.md) | Prices fetched by the backend for the whole token list | Accepted |
| [0012](0012-append-only-hash-chained-audit-log.md) | Append-only hash-chained audit log | Accepted |
| [0014](0014-qd-wallet-protocol-threshold-raccoon-with-stateless-derivation.md) | QD-Wallet protocol: Threshold Raccoon with stateless derivation | Accepted (research/testnet) |

ADR 0013 (threshold ECDSA for EVM EOAs) is still open. D1 showed that QD is a lattice scheme, not threshold ECDSA, so 0013 is only needed if ECDSA MPC accounts are still wanted.
