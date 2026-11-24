/**
 * An in-memory `KVNamespace` covering exactly the surface this Worker uses.
 *
 * No Workers runtime is needed for these tests: the store's contract is a handful of get/put/delete
 * calls, and faking them is what makes the device-limit, rotation and month-rollover behaviour
 * testable — including across two handler calls, which is the only way to test re-provisioning.
 */
export function fakeKv(): KVNamespace & { dump(): Map<string, string> } {
  const store = new Map<string, string>();
  const api = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> {
      let matching = [...store.keys()].filter((k) => !options?.prefix || k.startsWith(options.prefix));
      matching.sort();
      let startIndex = 0;
      if (options?.cursor) {
        const parsed = parseInt(options.cursor, 10);
        if (!isNaN(parsed)) {
          startIndex = parsed;
        } else {
          const idx = matching.indexOf(options.cursor);
          if (idx >= 0) startIndex = idx + 1;
        }
      }
      const limit = options?.limit ?? 1000;
      const pageKeys = matching.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + pageKeys.length;
      const list_complete = nextIndex >= matching.length;
      return {
        keys: pageKeys.map((name) => ({ name })),
        list_complete,
        cursor: list_complete ? undefined : String(nextIndex),
      };
    },
    dump(): Map<string, string> {
      return store;
    },
  };
  return api as unknown as KVNamespace & { dump(): Map<string, string> };
}
