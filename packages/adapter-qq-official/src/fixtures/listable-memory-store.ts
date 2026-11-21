import type {
  KeyValueEntry,
  KeyValueListOptions,
  KeyValueStore,
  ListableKeyValueStore,
  Logger
} from "@qq-bot/plugin-sdk";

/**
 * Test double for a store that supports prefix listing.
 *
 * This adapter must not depend on `@qq-bot/core`, so its tests cannot reuse
 * the kernel's `MemoryStore`.
 */
export class ListableMemoryStore implements ListableKeyValueStore {
  public readonly values = new Map<string, unknown>();

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
    const limit = options.limit ?? 100;
    const entries: KeyValueEntry<T>[] = [];
    for (const key of [...this.values.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      if (options.after !== undefined && key <= options.after) continue;
      entries.push({ key, value: this.values.get(key) as T });
      if (entries.length >= limit) break;
    }
    return entries;
  }
}

export class SilentLogger implements Logger {
  public readonly warnings: string[] = [];

  public debug(): void {}
  public info(): void {}
  public warn(...args: unknown[]): void {
    this.warnings.push(args.map((value) => String(value)).join(" "));
  }
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

/**
 * Store that records every write, for tests that assert the commit order of
 * the Gateway watermark. It cannot list keys, which is also what the
 * deduplicator's degraded path needs.
 */
export class RecordingStore implements KeyValueStore {
  public readonly values = new Map<string, unknown>();
  public readonly writes: { key: string; value: unknown }[] = [];

  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    this.writes.push({ key, value });
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
}
