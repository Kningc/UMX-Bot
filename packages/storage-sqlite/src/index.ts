import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { KeyValueStore } from "@qq-bot/plugin-sdk";

interface StoredRow {
  value: string;
}

export class SQLiteStore implements KeyValueStore {
  private readonly database: DatabaseSync;
  private readonly getStatement: StatementSync;
  private readonly setStatement: StatementSync;
  private readonly deleteStatement: StatementSync;
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

      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }

    this.getStatement = this.database.prepare(
      "SELECT value FROM plugin_kv WHERE key = ?"
    );
    this.setStatement = this.database.prepare(`
      INSERT INTO plugin_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = this.database.prepare(
      "DELETE FROM plugin_kv WHERE key = ?"
    );
  }

  public async get<T>(key: string): Promise<T | undefined> {
    this.assertOpen();
    const row = this.getStatement.get(key) as StoredRow | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.assertOpen();
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("SQLiteStore cannot persist undefined values");
    }
    this.setStatement.run(key, serialized, new Date().toISOString());
  }

  public async delete(key: string): Promise<boolean> {
    this.assertOpen();
    return this.deleteStatement.run(key).changes > 0;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SQLiteStore is closed");
    }
  }
}
