import type { Network } from '@qd/blockchain';

/**
 * Narrow the client registry to the networks this device can actually reach.
 *
 * `enabledIds` is the id list from `GET /v1/networks` — a chain is listed there
 * only when wallet-api has an upstream for it. `null` means the server has not
 * answered yet: the selector then shows the local registry, because a backend
 * outage must not empty the list, and the proxy still refuses chains it has no
 * upstream for, so failing open here costs nothing but a click.
 *
 * `customRpcIds` are networks the user pointed at their own RPC. Those bypass
 * the backend entirely (spec §25.5) and stay selectable whatever the server says.
 */
export function filterEnabledNetworks(
  networks: readonly Network[],
  enabledIds: readonly string[] | null,
  customRpcIds: readonly string[] = [],
): Network[] {
  if (enabledIds === null) return [...networks];
  const allowed = new Set([...enabledIds, ...customRpcIds]);
  return networks.filter((n) => allowed.has(n.id));
}

/**
 * Chains the backend proxies that this build has no client entry for — a chain
 * registered in `docs/api/networks.json` and the Go table but not yet in
 * `packages/blockchain/src/networks.ts`. They cannot be offered, and hiding the
 * fact costs a confusing support loop, so the network sheet names the count.
 */
export function unmodelledNetworkIds(enabledIds: readonly string[] | null, knownIds: readonly string[]): string[] {
  if (enabledIds === null) return [];
  const known = new Set(knownIds);
  return enabledIds.filter((id) => !known.has(id));
}
