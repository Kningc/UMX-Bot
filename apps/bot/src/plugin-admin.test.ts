import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotKernel } from "@umx-bot/core";
import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  NavigationPageSummary,
  OutgoingMessage,
  SentMessage
} from "@umx-bot/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginAdminPlugin } from "./plugin-admin.js";
import { PluginManager } from "./plugin-loader.js";

class TestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class TestAdapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  public navigationSyncs = 0;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }

  public async stop(): Promise<void> {
    this.onMessage = undefined;
  }

  public async syncNavigation(
    _pages: readonly NavigationPageSummary[]
  ): Promise<void> {
    this.navigationSyncs += 1;
  }

  public async send(message: OutgoingMessage): Promise<SentMessage> {
    this.sent.push(message);
    return {
      platform: this.name,
      scope: message.scope,
      conversationId: message.conversationId,
      id: `sent-${this.sent.length}`,
      timestamp: new Date()
    };
  }

  public run(content: string): Promise<string[]> {
    return this.runAs(content, "owner");
  }

  public async runAs(
    content: string,
    role: IncomingMessage["author"]["role"]
  ): Promise<string[]> {
    const before = this.sent.length;
    await this.onMessage?.({
      id: `message-${before}`,
      platform: this.name,
      scope: "direct",
      conversationId: "owner-dm",
      author: { id: "operator", role },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
    return this.sent
      .slice(before)
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content.text ?? "")
      );
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createWorkspace(): Promise<{
  manifestPath: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "qq-bot-plugin-admin-"));
  directories.push(directory);
  await writeFile(
    join(directory, "alpha.mjs"),
    'export default { name: "alpha", version: "1.0.0", setup() {} };'
  );
  await writeFile(
    join(directory, "beta.mjs"),
    'export default { name: "beta", version: "2.0.0", setup() {} };'
  );
  const manifestPath = join(directory, "plugins.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        { specifier: "./alpha.mjs" },
        { specifier: "./beta.mjs", enabled: false }
      ]
    })
  );
  return { manifestPath, directory };
}

async function addUnrelatedDisabledEntry(manifestPath: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.plugins.push({
    // Same shape as the disabled AI plugin in deploy/plugins.json.example:
    // a path that does not exist and a secret that is not in the environment.
    specifier: "/nonexistent/qbot-agent/dist/index.js",
    enabled: false,
    secrets: { apiKey: "DEFINITELY_UNSET_API_KEY" }
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function startBot(
  prepare?: (manifestPath: string, directory: string) => Promise<void>
): Promise<{
  bot: BotKernel;
  adapter: TestAdapter;
  manager: PluginManager;
}> {
  const { manifestPath, directory } = await createWorkspace();
  await prepare?.(manifestPath, directory);
  const adapter = new TestAdapter();
  const bot = new BotKernel({
    adapter,
    logger: new TestLogger(),
    ownerIds: ["operator"]
  });
  const manager = new PluginManager({
    manifestPath,
    environment: {},
    logger: new TestLogger()
  });
  await manager.loadAll(bot);
  await bot.load(createPluginAdminPlugin({ bot, manager }));
  await bot.start();
  return { bot, adapter, manager };
}

describe("runtime plugin management", () => {
  it("lists loaded and disabled plugins", async () => {
    const { bot, adapter } = await startBot();

    const [reply] = await adapter.run("/plugin list");
    expect(reply).toContain("alpha v1.0.0 — 运行中");
    expect(reply).toContain("plugin-admin");
    // A manifest entry with enabled: false is reported, not hidden.
    expect(reply).toContain("beta.mjs — 已停用");

    await bot.stop();
  });

  it("disables a running plugin and reports it as not loaded", async () => {
    const { bot, adapter } = await startBot();

    expect(await adapter.run("/plugin disable alpha")).toEqual([
      "已停用 alpha。重启后会按清单恢复。"
    ]);
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).not.toContain(
      "alpha"
    );
    const [reply] = await adapter.run("/plugin list");
    expect(reply).toContain("alpha — 清单已启用但未加载");

    await bot.stop();
  });

  it("re-syncs navigation when the plugin set changes while running", async () => {
    const { bot, adapter } = await startBot();
    const before = adapter.navigationSyncs;

    await adapter.run("/plugin disable alpha");
    expect(adapter.navigationSyncs).toBe(before + 1);

    await adapter.run("/plugin enable alpha");
    expect(adapter.navigationSyncs).toBe(before + 2);

    await bot.stop();
  });

  it("enables a plugin the manifest has disabled", async () => {
    const { bot, adapter } = await startBot();

    expect(await adapter.run("/plugin enable beta")).toEqual([
      "已启用 beta。注意它不会收到 bot.ready。"
    ]);
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toContain(
      "beta"
    );

    await bot.stop();
  });

  it("reports that a plugin is already running", async () => {
    const { bot, adapter } = await startBot();

    expect(await adapter.run("/plugin enable alpha")).toEqual([
      "alpha 已经在运行。"
    ]);

    await bot.stop();
  });

  it("reloads a path plugin and says code changes took effect", async () => {
    const { bot, adapter } = await startBot();

    expect(await adapter.run("/plugin reload alpha")).toEqual([
      "已重载 alpha，配置与代码都已生效。"
    ]);
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toContain(
      "alpha"
    );

    await bot.stop();
  });

  it("surfaces the real reason when an operation fails", async () => {
    const { bot, adapter } = await startBot();

    const [reply] = await adapter.run("/plugin enable nope");
    expect(reply).toContain("操作失败");
    expect(reply).toContain("nope");

    await bot.stop();
  });

  it("explains an unknown subcommand", async () => {
    const { bot, adapter } = await startBot();

    expect(await adapter.run("/plugin frobnicate")).toEqual([
      "未知子命令。可用：list、disable、enable、reload。"
    ]);

    await bot.stop();
  });

  it("refuses the command for a non-owner", async () => {
    const { manifestPath } = await createWorkspace();
    const adapter = new TestAdapter();
    // No ownerIds configured, so only a platform owner could pass.
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    const manager = new PluginManager({
      manifestPath,
      environment: {},
      logger: new TestLogger()
    });
    await manager.loadAll(bot);
    await bot.load(createPluginAdminPlugin({ bot, manager }));
    await bot.start();

    expect(await adapter.runAs("/plugin list", "member")).toEqual([
      "权限不足，无法执行该命令。"
    ]);
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toContain(
      "alpha"
    );

    await bot.stop();
  });
});

describe("runtime plugin management with an unrelated broken manifest entry", () => {
  it("enables a plugin even though another disabled entry cannot resolve", async () => {
    const { bot, adapter } = await startBot(addUnrelatedDisabledEntry);

    expect(await adapter.run("/plugin enable beta")).toEqual([
      "已启用 beta。注意它不会收到 bot.ready。"
    ]);

    await bot.stop();
  });

  it("reloads a plugin even though another disabled entry cannot resolve", async () => {
    const { bot, adapter } = await startBot(addUnrelatedDisabledEntry);

    expect(await adapter.run("/plugin reload alpha")).toEqual([
      "已重载 alpha，配置与代码都已生效。"
    ]);

    await bot.stop();
  });

  it("still reports the broken entry when it is the one asked for", async () => {
    const { bot, adapter } = await startBot(addUnrelatedDisabledEntry);

    const [reply] = await adapter.run(
      "/plugin enable /nonexistent/qbot-agent/dist/index.js"
    );
    expect(reply).toContain("操作失败");
    expect(reply).toContain("failed to import plugin");

    await bot.stop();
  });
});

describe("runtime plugin reload safety", () => {
  it("does not unload a plugin whose replacement fails to import", async () => {
    const { manifestPath, directory } = await createWorkspace();
    const adapter = new TestAdapter();
    const bot = new BotKernel({
      adapter,
      logger: new TestLogger(),
      ownerIds: ["operator"]
    });
    const manager = new PluginManager({
      manifestPath,
      environment: {},
      logger: new TestLogger()
    });
    await manager.loadAll(bot);
    await bot.load(createPluginAdminPlugin({ bot, manager }));
    await bot.start();

    // Break the module on disk *after* it loaded successfully.
    await writeFile(join(directory, "alpha.mjs"), "export default {{{");

    const [reply] = await adapter.run("/plugin reload alpha");
    expect(reply).toContain("操作失败");
    // The old, working build is still serving.
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toContain(
      "alpha"
    );

    await bot.stop();
  });

  it("refuses to disable or reload the admin plugin itself", async () => {
    const { bot, adapter } = await startBot();

    for (const action of ["disable", "reload"]) {
      expect(await adapter.run(`/plugin ${action} plugin-admin`)).toEqual([
        "不能在运行时停用或重载 plugin-admin 自己，否则只能重启才能恢复。"
      ]);
    }
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toContain(
      "plugin-admin"
    );

    await bot.stop();
  });
});
