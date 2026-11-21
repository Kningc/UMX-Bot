import type {
  KeyValueEntry,
  KeyValueListOptions,
  ListableKeyValueStore
} from "@qq-bot/plugin-sdk";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

export class MemoryStore implements ListableKeyValueStore {
  private readonly values = new Map<string, unknown>();

  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  public async update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    const next = updater(this.values.get(key) as T | undefined);
    if (next === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, next);
    }
    return next;
  }

  public async list<T>(
    prefix: string,
    options: KeyValueListOptions = {}
  ): Promise<KeyValueEntry<T>[]> {
    const limit = normalizeListLimit(options.limit);
    const after = options.after;
    const entries: KeyValueEntry<T>[] = [];
    for (const key of [...this.values.keys()].sort()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (after !== undefined && key <= after) {
        continue;
      }
      entries.push({ key, value: this.values.get(key) as T });
      if (entries.length >= limit) {
        break;
      }
    }
    return entries;
  }
}

export function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("key value listing limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}
