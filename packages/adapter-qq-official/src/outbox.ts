import type {
  KeyValueListOptions,
  KeyValueStore,
  Logger
} from "@umx-bot/plugin-sdk";
import { supportsListing } from "@umx-bot/plugin-sdk";
import type {
  PersistedOutboxRecord,
  PersistedStreamState
} from "./protocol.js";

export interface QqOutboxEntry {
  /** Full store key, usable with `get()` and `delete()`. */
  key: string;
  /** The idempotency key the caller originally supplied. */
  idempotencyKey: string;
  record: PersistedOutboxRecord;
  /**
   * True when the record only exists in this process because persisting it
   * failed. It is lost on restart, so it must be resolved before shutdown.
   */
  unpersisted: boolean;
}

/**
 * Idempotency ledger for QQ active/wakeup messages and active streams.
 *
 * Records are persisted when a store is configured. The in-memory map is used
 * only without a store, or to remember an uncertain record whose persistence
 * failed, so it stays bounded in normal operation.
 */
export class QqOutbox {
  private readonly memory = new Map<string, PersistedOutboxRecord>();

  public constructor(
    private readonly appId: string,
    private readonly store: KeyValueStore | undefined,
    private readonly logger: Logger
  ) {}

  public prefix(): string {
    return ["adapter", "qq-official", this.appId, "outbox", ""].join(":");
  }

  public key(idempotencyKey: string): string {
    return `${this.prefix()}${encodeURIComponent(idempotencyKey)}`;
  }

  /**
   * Lists outbox records so an operator can find the ones that need a human
   * decision — above all `uncertain`, which this adapter refuses to resend on
   * its own. Throws when the configured store cannot enumerate keys, so the
   * caller never mistakes "cannot look" for "nothing there".
   */
  public async list(
    options: KeyValueListOptions = {}
  ): Promise<QqOutboxEntry[]> {
    const prefix = this.prefix();
    const entries = new Map<string, QqOutboxEntry>();
    if (this.store) {
      if (!supportsListing(this.store)) {
        throw new Error(
          "the configured store cannot list keys, so the QQ outbox cannot be enumerated"
        );
      }
      for (const entry of await this.store.list<PersistedOutboxRecord>(
        prefix,
        options
      )) {
        entries.set(entry.key, {
          key: entry.key,
          idempotencyKey: decodeOutboxKey(entry.key, prefix),
          record: entry.value,
          unpersisted: false
        });
      }
    }
    // Records held only in memory (a failed persist, or no store at all) would
    // otherwise be invisible to the operator.
    for (const [key, record] of this.memory) {
      entries.set(key, {
        key,
        idempotencyKey: decodeOutboxKey(key, prefix),
        record,
        unpersisted: true
      });
    }
    return [...entries.values()].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    );
  }

  /** Number of records this process is holding because persistence failed. */
  public unpersistedCount(): number {
    return this.memory.size;
  }

  public async get(key: string): Promise<PersistedOutboxRecord | undefined> {
    return (
      this.memory.get(key) ??
      (await this.store?.get<PersistedOutboxRecord>(key))
    );
  }

  public async reserve(
    key: string
  ): Promise<{ record: PersistedOutboxRecord; created: boolean }> {
    const pending = (): PersistedOutboxRecord => ({
      status: "pending",
      updatedAt: new Date().toISOString()
    });
    if (!this.store) {
      const current = this.memory.get(key);
      if (current) {
        return { record: current, created: false };
      }
      const record = pending();
      this.memory.set(key, record);
      return { record, created: true };
    }
    const unpersisted = this.memory.get(key);
    if (unpersisted) {
      return { record: unpersisted, created: false };
    }
    let created = false;
    const record = await this.store.update<PersistedOutboxRecord>(
      key,
      (current) => {
        if (current) {
          return current;
        }
        created = true;
        return pending();
      }
    );
    if (!record) {
      throw new Error("QQ Outbox reservation did not return a record");
    }
    return { record, created };
  }

  public async set(key: string, record: PersistedOutboxRecord): Promise<void> {
    if (!this.store) {
      this.memory.set(key, record);
      return;
    }
    await this.store.set(key, record);
    this.memory.delete(key);
  }

  public async keepUncertain(
    key: string,
    sentCount: number,
    error: unknown
  ): Promise<void> {
    const record: PersistedOutboxRecord = {
      status: "uncertain",
      updatedAt: new Date().toISOString(),
      sentCount,
      error: error instanceof Error ? error.message : String(error)
    };
    await this.keepRecord(
      key,
      record,
      "QQ uncertain outbox state could not be persisted"
    );
  }

  public async keepUncertainStream(
    key: string,
    stream: PersistedStreamState,
    error: unknown
  ): Promise<void> {
    const record: PersistedOutboxRecord = {
      status: "uncertain",
      updatedAt: new Date().toISOString(),
      sentCount: stream.nextIndex,
      error: error instanceof Error ? error.message : String(error),
      stream
    };
    await this.keepRecord(
      key,
      record,
      "QQ uncertain stream state could not be persisted"
    );
  }

  /**
   * Persists a record that must survive; if the store write fails, the record
   * is kept in memory so this process still refuses a blind resend.
   */
  private async keepRecord(
    key: string,
    record: PersistedOutboxRecord,
    failureMessage: string
  ): Promise<void> {
    if (!this.store) {
      this.memory.set(key, record);
      return;
    }
    try {
      await this.store.set(key, record);
      this.memory.delete(key);
    } catch (storageError) {
      this.memory.set(key, record);
      this.logger.error(
        { error: storageError, outboxKey: key },
        failureMessage
      );
    }
  }

  public async delete(key: string): Promise<void> {
    this.memory.delete(key);
    await this.store?.delete(key);
  }
}

function decodeOutboxKey(key: string, prefix: string): string {
  const encoded = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
