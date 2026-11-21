import type { KeyValueStore } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  ListableMemoryStore as MemoryStore,
  SilentLogger
} from "./fixtures/listable-memory-store.js";
import { QqOutbox } from "./outbox.js";

function createOutbox(store?: KeyValueStore): QqOutbox {
  return new QqOutbox("app-1", store, new SilentLogger());
}

describe("QqOutbox listing", () => {
  it("lists persisted records with their original idempotency keys", async () => {
    const store = new MemoryStore();
    const outbox = createOutbox(store);

    await outbox.set(outbox.key("daily/report:2026-11-21"), {
      status: "uncertain",
      updatedAt: "2026-11-21T00:00:00.000Z",
      sentCount: 1,
      error: "fetch failed"
    });
    await outbox.set(outbox.key("welcome-42"), {
      status: "sent",
      updatedAt: "2026-11-20T00:00:00.000Z"
    });
    // Another adapter key under a sibling prefix must not be picked up.
    await store.set("adapter:qq-official:app-1:session", { sessionId: "s" });

    const entries = await outbox.list();
    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      "daily/report:2026-11-21",
      "welcome-42"
    ]);
    expect(entries[0]?.record.status).toBe("uncertain");
    expect(entries.every((entry) => !entry.unpersisted)).toBe(true);
  });

  it("does not mix records from another app id", async () => {
    const store = new MemoryStore();
    const mine = createOutbox(store);
    const other = new QqOutbox("app-2", store, new SilentLogger());

    await mine.set(mine.key("a"), {
      status: "sent",
      updatedAt: "2026-11-21T00:00:00.000Z"
    });
    await other.set(other.key("b"), {
      status: "sent",
      updatedAt: "2026-11-21T00:00:00.000Z"
    });

    await expect(
      mine.list().then((entries) => entries.map((e) => e.idempotencyKey))
    ).resolves.toEqual(["a"]);
  });

  it("surfaces records that could not be persisted", async () => {
    const store = new MemoryStore();
    const failing: KeyValueStore = {
      get: (key) => store.get(key),
      set: async () => {
        throw new Error("disk full");
      },
      delete: (key) => store.delete(key),
      update: (key, updater) => store.update(key, updater),
      list: (prefix, options) => store.list(prefix, options)
    };
    const outbox = createOutbox(failing);

    await outbox.keepUncertain(outbox.key("lost"), 1, new Error("timeout"));

    const entries = await outbox.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.unpersisted).toBe(true);
    expect(entries[0]?.idempotencyKey).toBe("lost");
    expect(outbox.unpersistedCount()).toBe(1);
  });

  it("refuses to report an empty outbox when the store cannot list keys", async () => {
    const store = new MemoryStore();
    const unlistable: KeyValueStore = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: (key) => store.delete(key),
      update: (key, updater) => store.update(key, updater)
    };
    const outbox = createOutbox(unlistable);

    await expect(outbox.list()).rejects.toThrow(/cannot list keys/u);
  });

  it("works without any store at all", async () => {
    const outbox = createOutbox();
    await outbox.keepUncertain(outbox.key("only-memory"), 0, "boom");

    const entries = await outbox.list();
    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      "only-memory"
    ]);
    expect(entries[0]?.unpersisted).toBe(true);
  });
});
