import type { ConversationRef } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";
import {
  PluginScopedStateRegistry,
  PluginSettingsRegistry
} from "./scoped-storage.js";

const group: ConversationRef = {
  platform: "qq",
  scope: "group",
  conversationId: "group-1"
};

const direct: ConversationRef = {
  platform: "qq",
  scope: "direct",
  conversationId: "user-1"
};

describe("PluginSettingsRegistry", () => {
  it("inherits and deep-merges settings by specificity", async () => {
    const registry = new PluginSettingsRegistry(new MemoryStore());
    const settings = registry.define({
      defaults: {
        enabled: true,
        limits: { daily: 10, burst: 2 },
        labels: ["default"]
      }
    });

    await settings.set(
      { level: "global" },
      { limits: { daily: 20 } }
    );
    await settings.set(
      { level: "chat", platform: "qq", scope: "group" },
      { limits: { burst: 5 } }
    );
    await settings.set(
      {
        level: "conversation",
        platform: "qq",
        scope: "group",
        conversationId: "group-1"
      },
      { enabled: false, labels: ["special"] }
    );

    await expect(settings.get(group)).resolves.toEqual({
      enabled: false,
      limits: { daily: 20, burst: 5 },
      labels: ["special"]
    });
    await expect(settings.get(direct)).resolves.toEqual({
      enabled: true,
      limits: { daily: 20, burst: 2 },
      labels: ["default"]
    });
  });

  it("validates before persisting and supports atomic updates", async () => {
    const registry = new PluginSettingsRegistry(new MemoryStore());
    const settings = registry.define({
      defaults: { threshold: 1 },
      schema: {
        parse(value) {
          const candidate = value as { threshold?: unknown };
          if (
            typeof candidate.threshold !== "number" ||
            candidate.threshold < 0
          ) {
            throw new Error("invalid threshold");
          }
          return candidate as { threshold: number };
        }
      }
    });
    const scope = {
      level: "conversation",
      platform: "qq",
      scope: "group",
      conversationId: "group-1"
    } as const;

    await expect(
      settings.set(scope, { threshold: -1 })
    ).rejects.toThrow("invalid threshold");
    await expect(settings.getOverrides(scope)).resolves.toBeUndefined();

    await Promise.all([
      settings.update(scope, (current) => ({
        threshold: (current.threshold ?? 0) + 1
      })),
      settings.update(scope, (current) => ({
        threshold: (current.threshold ?? 0) + 1
      }))
    ]);
    await expect(settings.get(group)).resolves.toEqual({ threshold: 2 });
  });

  it("migrates persisted overrides on read", async () => {
    const store = new MemoryStore();
    const oldRegistry = new PluginSettingsRegistry(store);
    const oldSettings = oldRegistry.define({
      version: 1,
      defaults: { intervalMs: 1_000 }
    });
    await oldSettings.set(
      { level: "platform", platform: "qq" },
      { intervalMs: 2_000 }
    );

    const newRegistry = new PluginSettingsRegistry(store);
    const newSettings = newRegistry.define({
      version: 2,
      defaults: { intervalSeconds: 1 },
      migrate(stored, fromVersion) {
        const previous = stored as { intervalMs?: number };
        expect(fromVersion).toBe(1);
        return {
          intervalSeconds: (previous.intervalMs ?? 1_000) / 1_000
        };
      }
    });

    await expect(newSettings.get(group)).resolves.toEqual({
      intervalSeconds: 2
    });
    await expect(
      newSettings.getOverrides({ level: "platform", platform: "qq" })
    ).resolves.toEqual({ intervalSeconds: 2 });
  });

  it("returns an inspection with every effective layer", async () => {
    const registry = new PluginSettingsRegistry(new MemoryStore());
    const settings = registry.define({
      defaults: { enabled: true, count: 1 }
    });
    await settings.set({ level: "global" }, { count: 2 });

    await expect(settings.inspect(group)).resolves.toEqual({
      value: { enabled: true, count: 2 },
      layers: {
        defaults: { enabled: true, count: 1 },
        global: { count: 2 }
      }
    });
  });
});

describe("PluginScopedStateRegistry", () => {
  it("isolates state between group and direct conversations", async () => {
    const state = new PluginScopedStateRegistry(new MemoryStore());
    const groupState = state.forConversation(group);
    const directState = state.forConversation(direct);

    await groupState.set("score", 10);
    await directState.set("score", 3);

    await expect(groupState.get("score")).resolves.toBe(10);
    await expect(directState.get("score")).resolves.toBe(3);
  });

  it("updates scoped values atomically", async () => {
    const state = new PluginScopedStateRegistry(new MemoryStore());
    const scoped = state.forConversation(group);

    await Promise.all([
      scoped.update<number>("count", (current) => (current ?? 0) + 1),
      scoped.update<number>("count", (current) => (current ?? 0) + 1)
    ]);

    await expect(scoped.get("count")).resolves.toBe(2);
  });
});
