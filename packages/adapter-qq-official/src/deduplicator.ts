import type { KeyValueStore, Logger } from "@qq-bot/plugin-sdk";
import { supportsListing } from "@qq-bot/plugin-sdk";

interface PersistedSeenMessage {
  seenAt: string;
}

export interface QqMessageDeduplicatorOptions {
  appId: string;
  store?: KeyValueStore | undefined;
  logger: Logger;
  /** How long a processed message stays remembered. */
  ttlMs?: number;
  /** Upper bound on the in-memory cache. */
  memoryLimit?: number;
  /** Minimum interval between background prunes of the persisted table. */
  pruneIntervalMs?: number;
  /** Maximum number of keys restored into memory at start. */
  restoreLimit?: number;
}

export interface QqMessageDeduplicatorSnapshot {
  /** Keys currently cached in memory. */
  size: number;
  /** Whether processed keys survive a process restart. */
  persisted: boolean;
  restored: number;
  pruned: number;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MEMORY_LIMIT = 1_000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RESTORE_LIMIT = 1_000;

/**
 * Remembers which QQ message events have already been processed.
 *
 * An in-memory cache alone is not enough: the Gateway only advances its
 * committed watermark for a *contiguous* run of finished events, so after a
 * restart a Resume can legitimately redeliver an event that was already
 * handled but never committed. With an empty cache that event would be
 * processed — and replied to — a second time. Persisting the keys closes that
 * window, and the TTL keeps the table bounded.
 *
 * Persistence requires a store that can enumerate keys, because otherwise the
 * table could never be pruned. Without one this degrades to the in-memory
 * cache and says so, rather than growing without limit.
 */
export class QqMessageDeduplicator {
  private readonly memory = new Map<string, number>();
  private readonly prefix: string;
  private readonly store: KeyValueStore | undefined;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly memoryLimit: number;
  private readonly pruneIntervalMs: number;
  private readonly restoreLimit: number;
  private readonly persisted: boolean;
  private lastPrunedAt = 0;
  private pruning: Promise<void> | undefined;
  private restoredCount = 0;
  private prunedCount = 0;

  public constructor(options: QqMessageDeduplicatorOptions) {
    this.prefix = ["adapter", "qq-official", options.appId, "seen", ""].join(
      ":"
    );
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.restoreLimit = options.restoreLimit ?? DEFAULT_RESTORE_LIMIT;
    const store = options.store;
    if (store && !supportsListing(store)) {
      this.store = undefined;
      this.persisted = false;
      this.logger.warn(
        "the configured store cannot list keys, so processed QQ message ids are kept in memory only; a Resume after a restart may redeliver an already handled message"
      );
    } else {
      this.store = store;
      this.persisted = store !== undefined;
    }
  }

  /** Loads the still-valid keys so a Resume right after start is deduplicated. */
  public async restore(): Promise<void> {
    const store = this.store;
    if (!store || !supportsListing(store)) {
      return;
    }
    try {
      const cutoff = Date.now() - this.ttlMs;
      const entries = await store.list<PersistedSeenMessage>(this.prefix, {
        limit: this.restoreLimit
      });
      let restored = 0;
      for (const entry of entries) {
        const seenAt = Date.parse(entry.value?.seenAt ?? "");
        if (!Number.isFinite(seenAt) || seenAt < cutoff) {
          continue;
        }
        this.memory.set(entry.key.slice(this.prefix.length), seenAt);
        restored += 1;
      }
      this.restoredCount = restored;
      if (restored > 0) {
        this.logger.info(
          { restored },
          "restored processed QQ message ids for deduplication"
        );
      }
    } catch (error) {
      // A failed restore is not fatal; it only narrows the protection window.
      this.logger.error(
        { error },
        "could not restore processed QQ message ids"
      );
    }
  }

  public async has(key: string): Promise<boolean> {
    const seenAt = this.memory.get(key);
    if (seenAt !== undefined) {
      if (seenAt >= Date.now() - this.ttlMs) {
        return true;
      }
      this.memory.delete(key);
    }
    if (!this.store) {
      return false;
    }
    try {
      const record = await this.store.get<PersistedSeenMessage>(
        this.storeKey(key)
      );
      if (!record) {
        return false;
      }
      const persistedAt = Date.parse(record.seenAt);
      if (!Number.isFinite(persistedAt)) {
        return false;
      }
      if (persistedAt < Date.now() - this.ttlMs) {
        return false;
      }
      this.memory.set(key, persistedAt);
      return true;
    } catch (error) {
      // Failing open would risk a duplicate reply; failing closed would drop a
      // real message. A read error is reported and treated as "not seen", the
      // same risk the in-memory-only implementation always had.
      this.logger.error(
        { error, deduplicationKey: key },
        "could not read the processed QQ message table"
      );
      return false;
    }
  }

  public async remember(key: string): Promise<void> {
    const now = Date.now();
    this.memory.set(key, now);
    this.evictMemory(now);
    if (!this.store) {
      return;
    }
    try {
      await this.store.set<PersistedSeenMessage>(this.storeKey(key), {
        seenAt: new Date(now).toISOString()
      });
    } catch (error) {
      this.logger.error(
        { error, deduplicationKey: key },
        "could not persist a processed QQ message id"
      );
    }
    this.schedulePrune(now);
  }

  public async prune(): Promise<number> {
    const store = this.store;
    if (!store || !supportsListing(store)) {
      return 0;
    }
    const cutoff = Date.now() - this.ttlMs;
    let removed = 0;
    let after: string | undefined;
    // Paged so a long-lived deployment never loads the whole table at once.
    for (let page = 0; page < 20; page += 1) {
      const entries = await store.list<PersistedSeenMessage>(this.prefix, {
        limit: 200,
        ...(after === undefined ? {} : { after })
      });
      if (entries.length === 0) {
        break;
      }
      for (const entry of entries) {
        const seenAt = Date.parse(entry.value?.seenAt ?? "");
        if (Number.isFinite(seenAt) && seenAt >= cutoff) {
          continue;
        }
        await store.delete(entry.key);
        this.memory.delete(entry.key.slice(this.prefix.length));
        removed += 1;
      }
      after = entries.at(-1)?.key;
      if (entries.length < 200) {
        break;
      }
    }
    this.prunedCount += removed;
    return removed;
  }

  public snapshot(): QqMessageDeduplicatorSnapshot {
    return {
      size: this.memory.size,
      persisted: this.persisted,
      restored: this.restoredCount,
      pruned: this.prunedCount
    };
  }

  private storeKey(key: string): string {
    return `${this.prefix}${encodeURIComponent(key)}`;
  }

  private evictMemory(now: number): void {
    if (this.memory.size <= this.memoryLimit) {
      return;
    }
    const cutoff = now - this.ttlMs;
    for (const [key, seenAt] of this.memory) {
      if (this.memory.size <= this.memoryLimit * 0.9) {
        break;
      }
      if (seenAt < cutoff || this.memory.size > this.memoryLimit) {
        this.memory.delete(key);
      }
    }
  }

  private schedulePrune(now: number): void {
    if (this.pruning || now - this.lastPrunedAt < this.pruneIntervalMs) {
      return;
    }
    this.lastPrunedAt = now;
    this.pruning = this.prune()
      .then((removed) => {
        if (removed > 0) {
          this.logger.debug(
            { removed },
            "pruned expired processed QQ message ids"
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          { error },
          "could not prune the processed QQ message table"
        );
      })
      .finally(() => {
        this.pruning = undefined;
      });
  }

  /** Awaits an in-flight background prune; used by tests and shutdown. */
  public async settle(): Promise<void> {
    await this.pruning;
  }
}
