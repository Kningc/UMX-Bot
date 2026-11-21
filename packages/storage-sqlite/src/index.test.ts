import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, SQLiteStore } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteStore", () => {
  it("persists JSON values across instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-bot-sqlite-"));
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
    const directory = mkdtempSync(join(tmpdir(), "qq-bot-sqlite-"));
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
    expect(store.getSchemaVersion()).toBe(1);
    await expect(store.get("legacy:key")).resolves.toBe("kept");
    store.close();
  });

  it("refuses to open a database newer than this build", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-bot-sqlite-"));
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
