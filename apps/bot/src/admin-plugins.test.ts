import { BotKernel, MemoryStore, StoreAccessPolicy } from "@umx-bot/core";
import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  OutgoingMessage,
  SentMessage
} from "@umx-bot/plugin-sdk";
import { definePlugin } from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createAccessAdminPlugin } from "./access-admin.js";
import { createConfigAdminPlugin } from "./config-admin.js";

class QuietLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class Adapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }
  public async stop(): Promise<void> {}
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
  /** Runs as the configured bot owner, who is a plain member of this group. */
  public asBotOwner(content: string, conversationId = "group-1") {
    return this.run(content, "member", conversationId, BOT_OWNER);
  }

  public async run(
    content: string,
    role: IncomingMessage["author"]["role"] = "admin",
    conversationId = "group-1",
    authorId = "operator"
  ): Promise<string> {
    const before = this.sent.length;
    await this.onMessage?.({
      id: `m-${before}`,
      platform: this.name,
      scope: "group",
      conversationId,
      author: { id: authorId, role },
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
      )
      .join("\n");
  }
}

const BOT_OWNER = "bot-owner";

async function createBot() {
  const adapter = new Adapter();
  const store = new MemoryStore();
  const access = new StoreAccessPolicy(store, {
    exemptPlugins: ["access-admin", "config-admin"]
  });
  const bot = new BotKernel({
    adapter,
    logger: new QuietLogger(),
    store,
    accessPolicy: access,
    ownerIds: [BOT_OWNER]
  });
  await bot.load(
    definePlugin({
      name: "games",
      version: "1.0.0",
      setup(context) {
        context.commands.register({
          name: "roll",
          description: "roll",
          async execute(command) {
            await command.reply("rolled");
          }
        });
        const settings = context.settings.define({
          defaults: { sides: 6, nested: { apiKey: "hunter2", label: "x" } },
          schema: {
            parse(value) {
              const candidate = value as { sides: number };
              if (typeof candidate.sides !== "number" || candidate.sides < 2) {
                throw new Error("sides must be at least 2");
              }
              return value as {
                sides: number;
                nested: { apiKey: string; label: string };
              };
            }
          }
        });
        context.commands.register({
          name: "sides",
          description: "sides",
          async execute(command) {
            await command.reply(
              String((await settings.get(command.message)).sides)
            );
          }
        });
      }
    })
  );
  await bot.load(createAccessAdminPlugin({ bot, access }));
  await bot.load(createConfigAdminPlugin({ bot }));
  await bot.start();
  return { adapter, bot };
}

describe("/acl", () => {
  it("disables and re-enables a plugin in the current chat only", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/roll", "member")).toBe("rolled");
    expect(await adapter.run("/acl disable games")).toContain(
      "已在当前聊天停用插件 games"
    );
    expect(await adapter.run("/roll", "member")).toBe("");
    expect(await adapter.run("/roll", "member", "group-2")).toBe("rolled");
    expect(await adapter.run("/acl status")).toContain("已停用插件：games");
    expect(await adapter.run("/acl enable games")).toContain("启用插件 games");
    expect(await adapter.run("/roll", "member")).toBe("rolled");
    expect(await adapter.run("/acl status")).toContain("没有停用的插件");
  });

  it("disables a single command by name or alias", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/acl disable roll")).toContain("命令 roll");
    expect(await adapter.run("/roll", "member")).toBe("");
    expect(await adapter.run("/sides", "member")).toBe("6");
    expect(await adapter.run("/acl status")).toContain("已停用命令：roll");
    await adapter.run("/acl enable roll");
    expect(await adapter.run("/roll", "member")).toBe("rolled");
  });

  it("protects its own plugin, unknown names and member callers", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/acl disable access-admin")).toContain(
      "cannot be disabled"
    );
    expect(await adapter.run("/acl disable acl")).toContain("受保护");
    expect(await adapter.run("/acl disable ghost")).toContain(
      "找不到插件或命令"
    );
    expect(await adapter.run("/acl status", "member")).toContain("权限不足");
    expect(await adapter.run("/acl disable")).toContain("缺少参数 name");
  });

  it("blocks users platform-wide, bot owner only", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/acl block someone")).toContain("权限不足");
    // A group owner rules one group, not the whole platform.
    expect(await adapter.run("/acl block someone", "owner")).toContain(
      "权限不足"
    );
    expect(await adapter.run("/acl blocked", "owner")).toContain("权限不足");
    expect(await adapter.asBotOwner("/acl blocked")).toContain("封禁名单为空");
    expect(await adapter.asBotOwner("/acl block operator-2")).toContain(
      "已封禁 operator-2"
    );
    expect(await adapter.asBotOwner("/acl blocked")).toContain("operator-2");
    expect(await adapter.asBotOwner("/acl unblock operator-2")).toContain(
      "已解除封禁"
    );
    expect(await adapter.asBotOwner("/acl blocked")).toContain("封禁名单为空");
  });

  it("does not let a group owner escape the blocklist", async () => {
    const { adapter } = await createBot();
    await adapter.asBotOwner("/acl block operator");
    expect(await adapter.run("/roll", "owner")).toBe("");
    expect(await adapter.asBotOwner("/roll")).toBe("rolled");
  });
});

describe("/config", () => {
  it("lists configurable plugins and shows layers with secrets masked", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/config list")).toBe("games");
    const shown = await adapter.run("/config show games");
    expect(shown).toContain('"sides": 6');
    expect(shown).toContain('"apiKey": "***"');
    expect(shown).not.toContain("hunter2");
    expect(shown).toContain("没有覆盖");
    expect(await adapter.run("/config show nothing")).toContain(
      "没有「nothing」的设置"
    );
  });

  it("sets values with JSON parsing and validates through the plugin schema", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/config set games sides 20")).toContain(
      "已更新 games sides"
    );
    expect(await adapter.run("/sides", "member")).toBe("20");
    expect(await adapter.run("/sides", "member", "group-2")).toBe("6");
    expect(
      await adapter.run("/config set games nested.label hello world")
    ).toContain("已更新");
    expect(await adapter.run("/config show games")).toContain("conversation:");
    expect(await adapter.run("/config set games sides 1")).toContain(
      "修改失败：sides must be at least 2"
    );
    expect(await adapter.run("/sides", "member")).toBe("20");
    expect(await adapter.run("/config set games __proto__.x 1")).toContain(
      "不合法"
    );
    expect(await adapter.run("/config set games")).toContain("缺少参数 path");
  });

  it("resets a path or everything", async () => {
    const { adapter } = await createBot();
    await adapter.run("/config set games sides 20");
    await adapter.run("/config set games nested.label hi");
    expect(await adapter.run("/config reset games sides")).toContain(
      "已重置 games sides"
    );
    expect(await adapter.run("/sides", "member")).toBe("6");
    expect(await adapter.run("/config reset games nested.label")).toContain(
      "已重置"
    );
    expect(await adapter.run("/config reset games")).toContain("已恢复默认");
    expect(await adapter.run("/config reset games")).toContain(
      "没有可重置的覆盖"
    );
    expect(await adapter.run("/config reset ghost")).toContain(
      "没有「ghost」的设置"
    );
  });

  it("restricts global edits to bot owners and applies them everywhere", async () => {
    const { adapter } = await createBot();
    expect(await adapter.run("/config set-global games sides 8")).toContain(
      "权限不足"
    );
    expect(
      await adapter.run("/config set-global games sides 8", "owner")
    ).toContain("权限不足");
    expect(await adapter.run("/config reset-global games", "owner")).toContain(
      "权限不足"
    );
    expect(
      await adapter.asBotOwner("/config set-global games sides 8")
    ).toContain("已更新");
    expect(await adapter.run("/sides", "member", "group-9")).toBe("8");
    expect(
      await adapter.asBotOwner("/config reset-global games sides")
    ).toContain("已重置");
    expect(await adapter.run("/sides", "member", "group-9")).toBe("6");
    expect(await adapter.asBotOwner("/config reset-global games")).toContain(
      "已恢复默认"
    );
  });

  it("reports when no plugin defines settings", async () => {
    const adapter = new Adapter();
    const bot = new BotKernel({ adapter, logger: new QuietLogger() });
    await bot.load(createConfigAdminPlugin({ bot }));
    await bot.start();
    expect(await adapter.run("/config list")).toContain(
      "目前没有插件定义了设置"
    );
    expect(await adapter.run("/config show x")).toContain(
      "目前没有插件定义了设置"
    );
    expect(await adapter.run("/config")).toContain("/config list");
  });
});
