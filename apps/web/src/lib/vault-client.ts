'use client';
import type { VaultOps, VaultOp, VaultRequestMsg, VaultResponseMsg } from './vault-protocol';

export class VaultClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultClientError';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** UI-thread handle to the KeyWorker. Holds no secrets itself. */
class VaultClient {
  private worker: Worker | undefined;
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly lockListeners = new Set<() => void>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./key-worker.ts', import.meta.url), { type: 'module', name: 'qd-key-worker' });
      this.worker.onmessage = (ev: MessageEvent<VaultResponseMsg>) => {
        const msg = ev.data;
        if ('event' in msg) {
          if (msg.event === 'locked') this.lockListeners.forEach((l) => l());
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new VaultClientError(msg.error.code, msg.error.message));
      };
    }
    return this.worker;
  }

  call<K extends VaultOp>(op: K, ...args: VaultOps[K]['req'] extends void ? [] : [VaultOps[K]['req']]): Promise<VaultOps[K]['res']> {
    const w = this.ensure();
    const id = this.seq++;
    const msg: VaultRequestMsg<K> = { id, op, args: args[0] as VaultOps[K]['req'] };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      w.postMessage(msg);
    });
  }

  onAutoLock(listener: () => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }
}

export const vault = new VaultClient();
