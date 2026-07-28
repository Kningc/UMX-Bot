import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "./index.js";

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
});
