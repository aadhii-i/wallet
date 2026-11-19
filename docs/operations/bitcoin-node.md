# Bitcoin Support via Esplora API

wallet-api uses the public Mempool.space Esplora REST API for Bitcoin data instead of a self-hosted Bitcoin Core node. The server never holds or receives spending keys; it only queries public blockchain data for addresses the client provides.

## Esplora Provider

The wallet uses the public Mempool.space Esplora API:

- **Testnet4**: https://mempool.space/testnet4/api
- **Mainnet**: https://mempool.space/api

No node installation or RPC credentials are required. The Esplora API is stateless and requires no watch-wallet setup.

## wallet-api configuration

```env
# Bitcoin Esplora REST API (server-side only; never exposed to clients).
# Bitcoin support is OFF while BTC_ESPLORA_URL is empty.
# Use the Mempool.space public API — no node required.
#   Testnet4: https://mempool.space/testnet4/api
#   Mainnet:  https://mempool.space/api
BTC_ESPLORA_URL=https://mempool.space/testnet4/api

# Network the Esplora instance indexes: mainnet or testnet4.
BTC_NETWORK=testnet4

# Fee policy bounds in sat/vB. Every quoted rate is clamped into this band.
BTC_FEE_FLOOR_SAT_VB=1
BTC_MAX_FEE_SAT_VB=500
```

`BTC_ESPLORA_URL` must use HTTPS for production (non-loopback) hosts. Production validation enforces this.

`BTC_NETWORK` is `mainnet` or `testnet4` and must match the network the Esplora instance indexes. A request for the other network returns 404, and so does every Bitcoin route while `BTC_ESPLORA_URL` is empty.

`BTC_FEE_FLOOR_SAT_VB` and `BTC_MAX_FEE_SAT_VB` bound every quoted fee rate (sat/vB); rates outside the band are clamped into it.

## How it works

Unlike Bitcoin Core's watch-wallet approach, Esplora is a stateless blockchain index. The client derives addresses locally and queries the server for each address:

- **UTXOs**: `GET /address/{address}/utxo` returns all unspent outputs
- **History**: `GET /address/{address}/txs` returns transaction history (paginated)
- **Transaction details**: `GET /tx/{txid}` returns full transaction data
- **Fee estimates**: `GET /fee-estimates` returns per-confirmation-target rates
- **Broadcasting**: `POST /tx` broadcasts a signed raw transaction

No descriptor import or address registration is needed. Every address is queryable on demand.

## Security model

- The server never holds spending keys. Only public addresses and already-signed transactions cross the server boundary.
- Bitcoin addresses are never logged in plaintext. The server logs a short hash (fingerprint) instead.
- Transaction building and signing happen entirely client-side. The server only broadcasts signed transactions.

## Operational checks

```bash
# Check Esplora API health
curl -s https://mempool.space/testnet4/api/blocks/tip/height

# Check wallet-api Bitcoin endpoint (requires authenticated session)
curl -s -H "Cookie: qd_at=..." https://your-wallet-api.example.com/v1/btc/testnet4/fees
```

- `/healthz` on wallet-api does not imply Bitcoin is reachable; use `/v1/btc/testnet4/fees` with a session for an end-to-end check.
- Do not log addresses in plaintext. wallet-api logs a short hash of an address instead.
- The Esplora API may be rate-limited; wallet-api applies per-session rate limits to all Bitcoin routes.

## Backup

The server does not hold user funds. The only backup that matters is the user's BIP-39 recovery phrase; all Bitcoin addresses and transaction history are derived from the seed and queryable via the public blockchain.

## Limitations

- **No mempool-aware balance**: Esplora reports confirmed UTXOs only. Pending receives appear in history but not in the UTXO set until confirmed.
- **Rate limiting**: The public Mempool.space API may rate-limit requests. Production deployments should monitor for 429 responses and implement backoff.
- **Network dependency**: Unlike a local node, this approach requires internet connectivity to the Mempool.space service.
