import type { KeyValueStore } from "@qq-bot/plugin-sdk";
import { supportsListing } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { prefixKeyValueStore } from "./prefixed-store.js";

describe("prefixKeyValueStore", () => {
  it("namespaces reads and writes", async () => {
    const backing = new MemoryStore();
    const store = prefixKeyValueStore(backing, "alpha");

    await store.set("enabled", true);
    await expect(store.get("enabled")).resolves.toBe(true);
    await expect(backing.get("alpha:enabled")).resolves.toBe(true);
  });

  it("lists only its own namespace with relative keys", async () => {
    const backing = new MemoryStore();
    const alpha = prefixKeyValueStore(backing, "alpha");
    const beta = prefixKeyValueStore(backing, "alphabet");
    await alpha.set("sub:1", "a1");
    await alpha.set("sub:2", "a2");
    await alpha.set("other", "x");
    // A namespace that merely starts with the same letters must not leak in.
    await beta.set("sub:1", "b1");

    expect(supportsListing(alpha)).toBe(true);
    await expect(alpha.list?.("sub:")).resolves.toEqual([
      { key: "sub:1", value: "a1" },
      { key: "sub:2", value: "a2" }
    ]);
  });

  it("pages with a relative cursor", async () => {
    const store = prefixKeyValueStore(new MemoryStore(), "alpha");
    for (const suffix of ["a", "b", "c"]) {
      await store.set(`p:${suffix}`, suffix);
    }

    const first = await store.list?.<string>("p:", { limit: 2 });
    expect(first?.map((entry) => entry.key)).toEqual(["p:a", "p:b"]);
    await expect(
      store.list?.<string>("p:", { after: first?.at(-1)?.key })
    ).resolves.toEqual([{ key: "p:c", value: "c" }]);
  });

  it("reports that it cannot list when the backing store cannot", async () => {
    const backing = new MemoryStore();
    const unlistable: KeyValueStore = {
      get: (key) => backing.get(key),
      set: (key, value) => backing.set(key, value),
      delete: (key) => backing.delete(key),
      update: (key, updater) => backing.update(key, updater)
    };

    // Exposing a list() that returned [] here would read as "no entries".
    expect(supportsListing(prefixKeyValueStore(unlistable, "alpha"))).toBe(
      false
    );
  });
});
