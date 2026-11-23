import { readFileSync } from "node:fs";
import { projectQqNavigation } from "@umx-bot/adapter-qq-official";
import { BotKernel, MemoryStore, StoreAccessPolicy } from "@umx-bot/core";
import help from "@umx-bot/plugin-help";
import minecraft from "@umx-bot/plugin-minecraft-status";
import ping from "@umx-bot/plugin-ping";
import type {
  BotAdapter,
  CommandSummary,
  Logger,
  NavigationPageSummary,
  SentMessage
} from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createAccessAdminPlugin } from "./access-admin.js";
import { createConfigAdminPlugin } from "./config-admin.js";
import { createPluginAdminPlugin } from "./plugin-admin.js";
import type { PluginManager } from "./plugin-loader.js";

class QuietLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class CapturingAdapter implements BotAdapter {
  public readonly name = "capture";
  public synced:
    | {
        pages: readonly NavigationPageSummary[];
        commands: readonly CommandSummary[];
      }
    | undefined;
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async send(): Promise<SentMessage> {
    throw new Error("not used");
  }
  public async syncNavigation(
    pages: readonly NavigationPageSummary[],
    commands: readonly CommandSummary[] = []
  ): Promise<void> {
    this.synced = { pages, commands };
  }
}

describe("deploy/qq-menu.json", () => {
  it("matches what the bot syncs with the built-in plugins", async () => {
    // The manual fallback must publish exactly what the bot itself would.
    const adapter = new CapturingAdapter();
    const store = new MemoryStore();
    const bot = new BotKernel({ adapter, logger: new QuietLogger(), store });
    await bot.load(help);
    await bot.load(ping);
    await bot.load(minecraft);
    await bot.load(
      createAccessAdminPlugin({ bot, access: new StoreAccessPolicy(store) })
    );
    await bot.load(createConfigAdminPlugin({ bot }));
    await bot.load(
      createPluginAdminPlugin({ bot, manager: {} as PluginManager })
    );
    await bot.start();

    const synced = adapter.synced;
    expect(synced).toBeDefined();
    const projection = projectQqNavigation(
      synced?.pages ?? [],
      synced?.commands
    );
    const file = JSON.parse(
      readFileSync(
        new URL("../../../deploy/qq-menu.json", import.meta.url),
        "utf8"
      )
    ) as {
      menu: { items: unknown[] };
      panels: Array<{ scope: "c2c" | "group"; panel: unknown }>;
    };
    expect(file.menu).toEqual(projection.menu);
    for (const entry of file.panels) {
      expect(entry.panel).toEqual(projection.panels[entry.scope]);
    }
    await bot.stop();
  });
});
