import type {
  KeyValueSetOptions,
  KeyValueStore,
  ListableKeyValueStore
} from "./index.js";

export interface CollectionEntry<T> {
  id: string;
  value: T;
}

export interface CollectionFindOptions<T> {
  /** Maximum number of results. Defaults to 100. */
  limit?: number;
  sort?: (left: CollectionEntry<T>, right: CollectionEntry<T>) => number;
}

/**
 * A small document collection on top of a `KeyValueStore`.
 *
 * Meant for plugin data that needs listing or ranking (check-ins, points,
 * leaderboards) at chat-bot scale. `find` and `count` scan the collection, so
 * keep collections to thousands of records, not millions. They need a store
 * that can enumerate keys and fail loudly otherwise instead of returning an
 * empty result.
 */
export interface Collection<T> {
  get(id: string): Promise<T | undefined>;
  put(id: string, value: T, options?: KeyValueSetOptions): Promise<void>;
  update(
    id: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  find(
    predicate?: (value: T, id: string) => boolean,
    options?: CollectionFindOptions<T>
  ): Promise<CollectionEntry<T>[]>;
  count(predicate?: (value: T, id: string) => boolean): Promise<number>;
}

const PAGE_SIZE = 500;
const DEFAULT_FIND_LIMIT = 100;

export function createCollection<T>(
  store: KeyValueStore,
  name: string
): Collection<T> {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error(
      `invalid collection name "${name}"; use lowercase letters, numbers, dot, underscore or dash`
    );
  }
  const namespace = `collection:${name}:`;
  const keyOf = (id: string): string => {
    if (id.length === 0) {
      throw new Error("collection id cannot be empty");
    }
    return `${namespace}${id}`;
  };

  const scan = async (
    visit: (entry: CollectionEntry<T>) => boolean | undefined
  ): Promise<void> => {
    if (typeof store.list !== "function") {
      throw new Error(
        "this collection's store cannot enumerate keys, so it cannot be scanned"
      );
    }
    const listable = store as ListableKeyValueStore;
    let after: string | undefined;
    for (;;) {
      const page = await listable.list<T>(namespace, {
        limit: PAGE_SIZE,
        after
      });
      for (const entry of page) {
        if (
          visit({
            id: entry.key.slice(namespace.length),
            value: entry.value
          }) === false
        ) {
          return;
        }
      }
      const last = page.at(-1);
      if (!last || page.length < PAGE_SIZE) {
        return;
      }
      after = last.key;
    }
  };

  return {
    // `async` so an invalid id rejects instead of throwing synchronously.
    get: async (id) => store.get<T>(keyOf(id)),
    put: async (id, value, options) => store.set(keyOf(id), value, options),
    update: async (id, updater) => store.update<T>(keyOf(id), updater),
    delete: async (id) => store.delete(keyOf(id)),
    async find(predicate, options = {}) {
      const limit = options.limit ?? DEFAULT_FIND_LIMIT;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError(
          "collection find limit must be a positive integer"
        );
      }
      const matches: CollectionEntry<T>[] = [];
      await scan((entry) => {
        if (!predicate || predicate(entry.value, entry.id)) {
          matches.push(entry);
          // Without a sort the first `limit` matches are enough; with one,
          // every match has to be seen before the top `limit` is known.
          if (!options.sort && matches.length >= limit) {
            return false;
          }
        }
        return true;
      });
      if (options.sort) {
        matches.sort(options.sort);
      }
      return matches.slice(0, limit);
    },
    async count(predicate) {
      let total = 0;
      await scan((entry) => {
        if (!predicate || predicate(entry.value, entry.id)) {
          total += 1;
        }
        return true;
      });
      return total;
    }
  };
}
