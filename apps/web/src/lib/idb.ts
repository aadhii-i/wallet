/**
 * Minimal promise wrapper over one IndexedDB object store. Usable from the main
 * thread and from workers. Only ever stores ciphertext or non-secret values.
 */
export function openKv(dbName: string, store = 'kv') {
  let dbp: Promise<IDBDatabase> | undefined;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };

  return {
    /** Read-modify-write in one transaction, serialized across tabs/workers. */
    update: async <T>(key: string, change: (value: T | undefined) => T): Promise<T> => {
      const d = await db();
      return new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, 'readwrite');
        const s = t.objectStore(store);
        let result: T;
        let failure: unknown;
        const read = s.get(key);
        read.onsuccess = () => {
          try { result = change(read.result as T | undefined); s.put(result, key); }
          catch (error) { failure = error; t.abort(); }
        };
        t.oncomplete = () => resolve(result!);
        t.onerror = () => reject(failure ?? t.error);
        t.onabort = () => reject(failure ?? t.error ?? new Error('Storage transaction aborted'));
      });
    },
    get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
    set: (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key)),
    del: (key: string) => tx('readwrite', (s) => s.delete(key)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
}
