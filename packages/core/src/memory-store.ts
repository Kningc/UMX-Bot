import type {
  KeyValueEntry,
  KeyValueListOptions,
  KeyValueSetOptions,
  ListableKeyValueStore
} from "@umx-bot/plugin-sdk";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

export class MemoryStore implements ListableKeyValueStore {
  private readonly values = new Map<string, unknown>();
  private readonly expiries = new Map<string, number>();

  public async get<T>(key: string): Promise<T | undefined> {
    return this.read<T>(key);
  }

  public async set<T>(
    key: string,
    value: T,
    options: KeyValueSetOptions = {}
  ): Promise<void> {
    if (
      options.ttlMs !== undefined &&
      (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
    ) {
      throw new RangeError("ttlMs must be a positive number");
    }
    this.values.set(key, value);
    if (options.ttlMs === undefined) {
      this.expiries.delete(key);
    } else {
      this.expiries.set(key, Date.now() + options.ttlMs);
    }
  }

  public async delete(key: string): Promise<boolean> {
    const existed = this.read(key) !== undefined;
    this.values.delete(key);
    this.expiries.delete(key);
    return existed;
  }

  /** Reads a key, dropping it first when it has expired. */
  private read<T>(key: string): T | undefined {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.values.delete(key);
      this.expiries.delete(key);
      return undefined;
    }
    return this.values.get(key) as T | undefined;
  }

  public async update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    const next = updater(this.read<T>(key));
    if (next === undefined) {
      this.values.delete(key);
      this.expiries.delete(key);
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
      if (!key.startsWith(prefix) || this.read(key) === undefined) {
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
