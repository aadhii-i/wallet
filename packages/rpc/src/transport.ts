import type { ApiClient } from './api-client';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

let nextId = 1;

/**
 * EIP-1193-style request function routed through wallet-api's RPC proxy.
 * Use with viem: `custom({ request: proxyRequest(api, chainId) })`.
 */
export function proxyRequest(api: ApiClient, chainId: number) {
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const id = nextId++;
    const res = (await api.rpc(chainId, { jsonrpc: '2.0', id, method, params: params ?? [] })) as JsonRpcResponse;
    if (res.error) throw new JsonRpcError(res.error.code, res.error.message, res.error.data);
    return res.result;
  };
}
