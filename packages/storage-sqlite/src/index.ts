import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  KeyValueEntry,
  KeyValueListOptions,
  KeyValueSetOptions,
  ListableKeyValueStore
} from "@umx-bot/plugin-sdk";

interface StoredRow {
  value: string;
  expires_at?: number | null;
}

interface StoredEntryRow extends StoredRow {
  key: string;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

/**
 * Schema version this build knows how to operate on.
 *
 * Opening a database stamped with a *higher* version is refused: the release
 * script rolls back to the previous release on a failed health check, and an
 * older binary must not keep writing to a schema it does not understand.
 */
export const SCHEMA_VERSION = 2;

interface Migration {
  to: number;
  apply: (database: DatabaseSync) => void;
}

const migrations: Migration[] = [
  {
    to: 1,
    apply: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS plugin_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    }
  },
  {
    // Optional per-entry expiry, in epoch milliseconds. NULL never expires.
    to: 2,
    apply: (database) => {
      database.exec(`
        ALTER TABLE plugin_kv ADD COLUMN expires_at INTEGER;
        CREATE INDEX IF NOT EXISTS plugin_kv_expires_at
          ON plugin_kv (expires_at) WHERE expires_at IS NOT NULL;
      `);
    }
  }
];

/** Expired rows are purged after this many TTL writes. */
const PURGE_EVERY_TTL_WRITES = 500;

export class SQLiteStore implements ListableKeyValueStore {
  private readonly database: DatabaseSync;
  private readonly getStatement: StatementSync;
  private readonly setStatement: StatementSync;
  private readonly deleteStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly listAfterStatement: StatementSync;
  private readonly purgeStatement: StatementSync;
  private ttlWrites = 0;
  private closed = false;

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }

    // Expired rows are filtered in SQL so a stale value is never returned,
    // even before the periodic purge removes it.
    this.getStatement = this.database.prepare(
      "SELECT value, expires_at FROM plugin_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)"
    );
    this.setStatement = this.database.prepare(`
      INSERT INTO plugin_kv (key, value, updated_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `);
    this.purgeStatement = this.database.prepare(
      "DELETE FROM plugin_kv WHERE expires_at IS NOT NULL AND expires_at <= ?"
    );
    this.purgeExpired();
    this.deleteStatement = this.database.prepare(
      "DELETE FROM plugin_kv WHERE key = ?"
    );
    // `key >= ?` lets SQLite seek on the primary key instead of scanning from
    // the first row, while `substr(...) = ?` keeps the filter exact under any
    // collation. Ordering by key makes `after` a stable paging cursor.
    this.listStatement = this.database.prepare(`
      SELECT key, value FROM plugin_kv
      WHERE key >= :prefix AND substr(key, 1, :length) = :prefix
        AND (expires_at IS NULL OR expires_at > :now)
      ORDER BY key
      LIMIT :limit
    `);
    this.listAfterStatement = this.database.prepare(`
      SELECT key, value FROM plugin_kv
      WHERE key > :after AND substr(key, 1, :length) = :prefix
        AND (expires_at IS NULL OR expires_at > :now)
      ORDER BY key
      LIMIT :limit
    `);
  }

  public async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    const row = this.getStatement.get(key, Date.now()) as StoredRow | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  public async set<T>(
    key: string,
    value: T,
    options: KeyValueSetOptions = {}
  ): Promise<void> {
    this.assertOpen();
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("SQLiteStore cannot persist undefined values");
    }
    let expiresAt: number | null = null;
    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError("ttlMs must be a positive number");
      }
      expiresAt = Math.ceil(Date.now() + options.ttlMs);
      this.ttlWrites += 1;
      if (this.ttlWrites >= PURGE_EVERY_TTL_WRITES) {
        this.purgeExpired();
      }
    }
    this.setStatement.run(key, serialized, new Date().toISOString(), expiresAt);
  }

  /** Deletes expired rows. Runs on open and periodically on TTL writes. */
  public purgeExpired(): number {
    this.assertOpen();
    this.ttlWrites = 0;
    return Number(this.purgeStatement.run(Date.now()).changes);
  }

  public async delete(key: string): Promise<boolean> {
    this.assertOpen();
    return this.deleteStatement.run(key).changes > 0;
  }

  public async update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getStatement.get(key, Date.now()) as
        | StoredRow
        | undefined;
      const current = row ? (JSON.parse(row.value) as T) : undefined;
      const next = updater(current);
      if (next === undefined) {
        this.deleteStatement.run(key);
      } else {
        const serialized = JSON.stringify(next);
        if (serialized === undefined) {
          throw new TypeError("SQLiteStore cannot persist undefined values");
        }
        // The entry keeps the expiry it already had.
        this.setStatement.run(
          key,
          serialized,
          new Date().toISOString(),
          row?.expires_at ?? null
        );
      }
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async list<T>(
    prefix: string,
    options: KeyValueListOptions = {}
  ): Promise<KeyValueEntry<T>[]> {
    this.assertOpen();
    const limit = normalizeListLimit(options.limit);
    // SQLite `substr` counts characters, JavaScript `.length` counts UTF-16
    // code units; they differ for astral prefixes, so count code points. The
    // `startsWith` filter below keeps the result exact either way.
    const length = [...prefix].length;
    const now = Date.now();
    const rows = (options.after === undefined
      ? this.listStatement.all({ prefix, length, limit, now })
      : this.listAfterStatement.all({
          after: options.after,
          prefix,
          length,
          limit,
          now
        })) as unknown as StoredEntryRow[];
    return rows
      .filter((row) => row.key.startsWith(prefix))
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }

  public getSchemaVersion(): number {
    this.assertOpen();
    return this.readSchemaVersion();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.database.close();
    this.closed = true;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    const current = this.readSchemaVersion();
    if (current > SCHEMA_VERSION) {
      this.database.close();
      this.closed = true;
      throw new Error(
        `database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); upgrade the application instead of downgrading it`
      );
    }
    if (current === SCHEMA_VERSION) {
      // A legacy file already has the v1 shape but no version row; stamp it so
      // later opens do not have to infer the version from the table list. Only
      // write when the row is really missing: an unconditional write takes a
      // write lock on every start, which collides with an overlapping restart.
      const stamped = this.database
        .prepare(
          "SELECT 1 AS present FROM schema_meta WHERE key = 'schema_version'"
        )
        .get();
      if (!stamped) {
        this.writeSchemaVersion(SCHEMA_VERSION);
      }
      return;
    }
    const pending = migrations
      .filter((migration) => migration.to > current)
      .sort((left, right) => left.to - right.to);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of pending) {
        migration.apply(this.database);
        this.writeSchemaVersion(migration.to);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  private readSchemaVersion(): number {
    const row = this.database
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as StoredRow | undefined;
    if (!row) {
      // A database written before versioning existed already has the v1
      // `plugin_kv` shape, so treat a legacy file with that table as v1.
      const legacy = this.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_kv'"
        )
        .get() as { name: string } | undefined;
      return legacy ? 1 : 0;
    }
    const version = Number.parseInt(row.value, 10);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `database schema_version "${row.value}" is not a valid version`
      );
    }
    return version;
  }

  private writeSchemaVersion(version: number): void {
    this.database
      .prepare(`
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(String(version));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SQLiteStore is closed");
    }
  }
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("key value listing limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}
