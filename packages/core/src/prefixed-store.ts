import type { KeyValueEntry, KeyValueStore } from "@umx-bot/plugin-sdk";
import { supportsListing } from "@umx-bot/plugin-sdk";

/**
 * Namespaces a store under `<prefix>:`.
 *
 * `list()` is exposed only when the backing store can enumerate keys, so
 * `supportsListing()` on the wrapper tells the truth: a plugin must never be
 * told "no entries" by a store that simply cannot look.
 */
export function prefixKeyValueStore(
  store: KeyValueStore,
  prefix: string
): KeyValueStore {
  const namespace = `${prefix}:`;
  const wrapper: KeyValueStore = {
    get: (key) => store.get(`${namespace}${key}`),
    set: (key, value, options) =>
      store.set(`${namespace}${key}`, value, options),
    delete: (key) => store.delete(`${namespace}${key}`),
    update: (key, updater) => store.update(`${namespace}${key}`, updater)
  };
  if (supportsListing(store)) {
    wrapper.list = async <T>(
      listPrefix: string,
      options: { limit?: number | undefined; after?: string | undefined } = {}
    ): Promise<KeyValueEntry<T>[]> => {
      const entries = await store.list<T>(`${namespace}${listPrefix}`, {
        limit: options.limit,
        after:
          options.after === undefined
            ? undefined
            : `${namespace}${options.after}`
      });
      // Callers only ever see keys relative to their own namespace.
      return entries.map((entry) => ({
        key: entry.key.slice(namespace.length),
        value: entry.value
      }));
    };
  }
  return wrapper;
}
