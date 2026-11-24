import { EVM_NETWORKS } from '@qd/blockchain';

/** Shared-wallet amounts use the native currency of the proposal's network. */
export function nativeSymbol(chainId: number): string {
  const symbol = EVM_NETWORKS.find((network) => network.chainId === chainId)?.nativeCurrency.symbol ?? 'ETH';
  return symbol === 'SepoliaETH' ? 'ETH' : symbol;
}
