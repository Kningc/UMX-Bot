import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, SQLiteStore } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteStore", () => {
  it("persists JSON values across instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umx-bot-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bot.sqlite");

    const first = new SQLiteStore(path);
    await first.set("plugin:settings", { enabled: true, count: 3 });
    first.close();

    const second = new SQLiteStore(path);
    await expect(second.get("plugin:settings")).resolves.toEqual({
      enabled: true,
      count: 3
    });
    second.close();
  });

  it("deletes stored values", async () => {
    const store = new SQLiteStore(":memory:");
    await store.set("key", "value");

    await expect(store.delete("key")).resolves.toBe(true);
    await expect(store.get("key")).resolves.toBeUndefined();
    store.close();
  });

  it("atomically updates values and rolls back failed updates", async () => {
    const store = new SQLiteStore(":memory:");
    await store.set("count", 1);

    await expect(
      store.update<number>("count", (current) => (current ?? 0) + 1)
    ).resolves.toBe(2);
    await expect(
      store.update("count", () => {
        throw new Error("stop");
      })
    ).rejects.toThrow("stop");
    await expect(store.get("count")).resolves.toBe(2);
    store.close();
  });

  it("lists entries by key prefix in ascending order", async () => {
    const store = new SQLiteStore(":memory:");
    await store.set("adapter:qq:outbox:b", { status: "uncertain" });
    await store.set("adapter:qq:outbox:a", { status: "sent" });
    await store.set("adapter:qq:session", { sessionId: "s" });
    await store.set("plugin:other", 1);

    await expect(store.list("adapter:qq:outbox:")).resolves.toEqual([
      { key: "adapter:qq:outbox:a", value: { status: "sent" } },
      { key: "adapter:qq:outbox:b", value: { status: "uncertain" } }
    ]);
    store.close();
  });

  it("pages a prefix with limit and after", async () => {
    const store = new SQLiteStore(":memory:");
    for (const suffix of ["a", "b", "c", "d"]) {
      await store.set(`p:${suffix}`, suffix);
    }

    const first = await store.list<string>("p:", { limit: 2 });
    expect(first.map((entry) => entry.key)).toEqual(["p:a", "p:b"]);

    const second = await store.list<string>("p:", {
      limit: 2,
      after: first.at(-1)?.key
    });
    expect(second.map((entry) => entry.key)).toEqual(["p:c", "p:d"]);

    await expect(
      store.list<string>("p:", { after: second.at(-1)?.key })
    ).resolves.toEqual([]);
    store.close();
  });

  it("rejects a non-positive listing limit", async () => {
    const store = new SQLiteStore(":memory:");
    await expect(store.list("p:", { limit: 0 })).rejects.toThrow(RangeError);
    await expect(store.list("p:", { limit: 1.5 })).rejects.toThrow(RangeError);
    store.close();
  });

  it("does not leak neighbouring prefixes", async () => {
    const store = new SQLiteStore(":memory:");
    await store.set("outbox", "bare");
    await store.set("outbox:1", "inside");
    await store.set("outbox-other:1", "outside");

    await expect(store.list<string>("outbox:")).resolves.toEqual([
      { key: "outbox:1", value: "inside" }
    ]);
    store.close();
  });

  it("stamps the schema version on a fresh database", async () => {
    const store = new SQLiteStore(":memory:");
    expect(store.getSchemaVersion()).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("adopts a legacy database that predates schema versioning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umx-bot-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "legacy.sqlite");

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO plugin_kv VALUES ('legacy:key', '"kept"', '2026-01-01');
    `);
    legacy.close();

    const store = new SQLiteStore(path);
    expect(store.getSchemaVersion()).toBe(SCHEMA_VERSION);
    await expect(store.get("legacy:key")).resolves.toBe("kept");
    store.close();
  });

  it("refuses to open a database newer than this build", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umx-bot-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "future.sqlite");

    const future = new DatabaseSync(path);
    future.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES ('schema_version', '999');
    `);
    future.close();

    expect(() => new SQLiteStore(path)).toThrow(/newer than this build/u);
  });
});

describe("SQLiteStore ttl", () => {
  it("expires entries, skips them in listings and keeps expiry across update", async () => {
    vi.useFakeTimers();
    try {
      const store = new SQLiteStore(":memory:");
      await store.set("a", 1, { ttlMs: 1_000 });
      await store.set("b", 2);
      await store.set("c", 3, { ttlMs: 5_000 });
      await store.update<number>("c", (current) => (current ?? 0) + 1);
      await expect(store.get("c")).resolves.toBe(4);
      await expect(store.list("")).resolves.toHaveLength(3);

      vi.advanceTimersByTime(1_500);
      await expect(store.get("a")).resolves.toBeUndefined();
      await expect(store.list("")).resolves.toEqual([
        { key: "b", value: 2 },
        { key: "c", value: 4 }
      ]);
      await expect(store.list("", { after: "b" })).resolves.toEqual([
        { key: "c", value: 4 }
      ]);

      vi.advanceTimersByTime(5_000);
      await expect(store.get("c")).resolves.toBeUndefined();
      // update on an expired key sees it as absent and stores without expiry.
      await store.update<number>("c", (current) => (current ?? 0) + 10);
      vi.advanceTimersByTime(60_000);
      await expect(store.get("c")).resolves.toBe(10);

      expect(store.purgeExpired()).toBe(1);
      expect(store.purgeExpired()).toBe(0);
      await expect(store.set("x", 1, { ttlMs: -1 })).rejects.toThrow("ttlMs");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("purges expired rows on open and periodically on ttl writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umx-bot-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "ttl.sqlite");
    vi.useFakeTimers();
    try {
      const first = new SQLiteStore(path);
      await first.set("old", 1, { ttlMs: 10 });
      first.close();
      vi.advanceTimersByTime(1_000);

      const second = new SQLiteStore(path);
      expect(second.purgeExpired()).toBe(0);
      for (let index = 0; index < 600; index += 1) {
        await second.set(`k${index}`, index, { ttlMs: 1 });
        vi.advanceTimersByTime(2);
      }
      expect(second.purgeExpired()).toBeLessThan(600);
      second.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("upgrades a v1 database in place", async () => {
    const directory = mkdtempSync(join(tmpdir(), "umx-bot-sqlite-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "v1.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta VALUES ('schema_version', '1');
      CREATE TABLE plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      INSERT INTO plugin_kv VALUES ('kept', '7', '2026-01-01');
    `);
    legacy.close();
    const store = new SQLiteStore(path);
    expect(store.getSchemaVersion()).toBe(2);
    await expect(store.get("kept")).resolves.toBe(7);
    await store.set("fresh", 1, { ttlMs: 1_000 });
    store.close();
  });
});
