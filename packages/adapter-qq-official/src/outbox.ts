import type { KeyValueStore, Logger } from "@qq-bot/plugin-sdk";
import type {
  PersistedOutboxRecord,
  PersistedStreamState
} from "./protocol.js";

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

  public key(idempotencyKey: string): string {
    return [
      "adapter",
      "qq-official",
      this.appId,
      "outbox",
      encodeURIComponent(idempotencyKey)
    ].join(":");
  }

  public async get(
    key: string
  ): Promise<PersistedOutboxRecord | undefined> {
    return this.memory.get(key) ?? (await this.store?.get<PersistedOutboxRecord>(key));
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

  public async set(
    key: string,
    record: PersistedOutboxRecord
  ): Promise<void> {
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
    await this.keepRecord(key, record, "QQ uncertain outbox state could not be persisted");
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
    await this.keepRecord(key, record, "QQ uncertain stream state could not be persisted");
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
      this.logger.error({ error: storageError, outboxKey: key }, failureMessage);
    }
  }

  public async delete(key: string): Promise<void> {
    this.memory.delete(key);
    await this.store?.delete(key);
  }
}
