import type { KeyValueStore } from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { QqMessageDeduplicator } from "./deduplicator.js";
import {
  ListableMemoryStore,
  SilentLogger
} from "./fixtures/listable-memory-store.js";

function createDeduplicator(
  store: KeyValueStore | undefined,
  overrides: { ttlMs?: number; memoryLimit?: number } = {}
): QqMessageDeduplicator {
  return new QqMessageDeduplicator({
    appId: "app-1",
    store,
    logger: new SilentLogger(),
    ...overrides
  });
}

describe("QqMessageDeduplicator", () => {
  it("remembers a key within the same process", async () => {
    const deduplicator = createDeduplicator(undefined);

    await expect(deduplicator.has("msg-1:0")).resolves.toBe(false);
    await deduplicator.remember("msg-1:0");
    await expect(deduplicator.has("msg-1:0")).resolves.toBe(true);
  });

  it("still deduplicates after a process restart", async () => {
    const store = new ListableMemoryStore();

    const before = createDeduplicator(store);
    await before.restore();
    await before.remember("msg-1:0");
    await before.settle();

    // A new instance stands in for the restarted process: a Gateway Resume can
    // redeliver an event whose watermark was never committed.
    const after = createDeduplicator(store);
    await after.restore();
    await expect(after.has("msg-1:0")).resolves.toBe(true);
    expect(after.snapshot().restored).toBe(1);
    expect(after.snapshot().persisted).toBe(true);
  });

  it("finds a persisted key even when it was not restored into memory", async () => {
    const store = new ListableMemoryStore();
    const before = createDeduplicator(store);
    await before.remember("msg-2:1");

    // No restore() call, so memory starts empty and `has()` must fall back to
    // the store rather than reporting the message as new.
    const after = createDeduplicator(store);
    await expect(after.has("msg-2:1")).resolves.toBe(true);
  });

  it("forgets keys older than the ttl", async () => {
    const store = new ListableMemoryStore();
    const deduplicator = createDeduplicator(store, { ttlMs: 1 });
    await deduplicator.remember("msg-3:0");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(deduplicator.has("msg-3:0")).resolves.toBe(false);

    const restarted = createDeduplicator(store, { ttlMs: 1 });
    await restarted.restore();
    expect(restarted.snapshot().restored).toBe(0);
    await expect(restarted.has("msg-3:0")).resolves.toBe(false);
  });

  it("prunes expired keys out of the store", async () => {
    const store = new ListableMemoryStore();
    const deduplicator = createDeduplicator(store, { ttlMs: 1 });
    await deduplicator.remember("old-1:0");
    await deduplicator.remember("old-2:0");
    expect(store.values.size).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(deduplicator.prune()).resolves.toBe(2);
    expect(store.values.size).toBe(0);
  });

  it("keys are isolated per app id", async () => {
    const store = new ListableMemoryStore();
    const first = createDeduplicator(store);
    await first.remember("msg-4:0");

    const second = new QqMessageDeduplicator({
      appId: "app-2",
      store,
      logger: new SilentLogger()
    });
    await second.restore();
    await expect(second.has("msg-4:0")).resolves.toBe(false);
  });

  it("degrades to memory only, and says so, when the store cannot list keys", async () => {
    const backing = new ListableMemoryStore();
    const unlistable: KeyValueStore = {
      get: (key) => backing.get(key),
      set: (key, value) => backing.set(key, value),
      delete: (key) => backing.delete(key),
      update: (key, updater) => backing.update(key, updater)
    };
    const logger = new SilentLogger();
    const deduplicator = new QqMessageDeduplicator({
      appId: "app-1",
      store: unlistable,
      logger
    });

    expect(deduplicator.snapshot().persisted).toBe(false);
    expect(logger.warnings.join(" ")).toMatch(/cannot list keys/u);

    await deduplicator.remember("msg-5:0");
    // Nothing was written, so the table can never grow without bound.
    expect(backing.values.size).toBe(0);
    await expect(deduplicator.has("msg-5:0")).resolves.toBe(true);
  });

  it("treats a read failure as not seen instead of dropping the message", async () => {
    const backing = new ListableMemoryStore();
    const failing: KeyValueStore = {
      get: async () => {
        throw new Error("database is locked");
      },
      set: (key, value) => backing.set(key, value),
      delete: (key) => backing.delete(key),
      update: (key, updater) => backing.update(key, updater),
      list: (prefix, options) => backing.list(prefix, options)
    };
    const deduplicator = createDeduplicator(failing);

    await expect(deduplicator.has("msg-6:0")).resolves.toBe(false);
  });

  it("keeps the in-memory cache bounded", async () => {
    const deduplicator = createDeduplicator(undefined, { memoryLimit: 10 });
    for (let index = 0; index < 50; index += 1) {
      await deduplicator.remember(`msg-${index}:0`);
    }
    expect(deduplicator.snapshot().size).toBeLessThanOrEqual(10);
  });
});
