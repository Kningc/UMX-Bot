import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";

describe("MemoryStore", () => {
  it("stores, reads, updates and deletes values", async () => {
    const store = new MemoryStore();

    await store.set("count", 1);
    await expect(store.get("count")).resolves.toBe(1);
    await expect(
      store.update<number>("count", (current) => (current ?? 0) + 1)
    ).resolves.toBe(2);
    await expect(store.delete("count")).resolves.toBe(true);
    await expect(store.delete("count")).resolves.toBe(false);
    await expect(store.get("count")).resolves.toBeUndefined();
  });

  it("removes a key when the updater returns undefined", async () => {
    const store = new MemoryStore();
    await store.set("key", "value");

    await expect(store.update("key", () => undefined)).resolves.toBeUndefined();
    await expect(store.get("key")).resolves.toBeUndefined();
  });

  it("lists entries by prefix in ascending key order", async () => {
    const store = new MemoryStore();
    await store.set("outbox:b", 2);
    await store.set("outbox:a", 1);
    await store.set("outbox-other:a", 0);
    await store.set("session", "s");

    await expect(store.list<number>("outbox:")).resolves.toEqual([
      { key: "outbox:a", value: 1 },
      { key: "outbox:b", value: 2 }
    ]);
  });

  it("pages a prefix the same way the SQLite store does", async () => {
    const store = new MemoryStore();
    for (const suffix of ["a", "b", "c"]) {
      await store.set(`p:${suffix}`, suffix);
    }

    const first = await store.list<string>("p:", { limit: 2 });
    expect(first.map((entry) => entry.key)).toEqual(["p:a", "p:b"]);
    await expect(
      store.list<string>("p:", { after: first.at(-1)?.key })
    ).resolves.toEqual([{ key: "p:c", value: "c" }]);
  });

  it("rejects an invalid listing limit", async () => {
    const store = new MemoryStore();
    await expect(store.list("p:", { limit: 0 })).rejects.toThrow(RangeError);
    await expect(store.list("p:", { limit: -1 })).rejects.toThrow(RangeError);
  });
});
