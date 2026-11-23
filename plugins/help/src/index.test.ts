import {
  definePlugin,
  helpService,
  PLUGIN_API_VERSION,
  type RichMessageContent
} from "@umx-bot/plugin-sdk";
import { createPluginTestHost } from "@umx-bot/plugin-testkit";
import { describe, expect, it } from "vitest";
import helpPlugin, { isMentionOnly, parseHelpConfig } from "./index.js";

const tools = definePlugin({
  name: "tools",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  help: { title: "工具" },
  setup(context) {
    context.commands.register({
      name: "echo",
      description: "复读文本",
      execute: (command) => command.reply(command.rawArgs)
    });
    context.commands.register({
      name: "admin",
      description: "管理工具",
      permission: "admin",
      subcommands: [
        {
          name: "status",
          description: "查看状态",
          execute: (command) => command.reply("ok")
        },
        {
          name: "wipe",
          description: "清空数据",
          permission: "owner",
          execute: (command) => command.reply("wiped")
        }
      ]
    });
    context.navigation.register({
      items: [{ label: "复读", command: "echo", args: "hi", featured: true }]
    });
  }
});

const secret = definePlugin({
  name: "secret",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  help: { title: "秘密" },
  setup(context) {
    context.commands.register({
      name: "secret",
      description: "不该出现",
      execute: (command) => command.reply("shh")
    });
  }
});

function markdownOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : ((content as RichMessageContent).markdown ?? "");
}

async function host() {
  const instance = createPluginTestHost({
    // Stands in for `/acl disable secret` in this chat.
    accessPolicy: {
      check: ({ plugin }) => ({ allowed: plugin !== "secret" })
    }
  });
  await instance.load(helpPlugin, { config: { title: "测试机器人" } });
  await instance.load(tools);
  await instance.load(secret);
  await instance.start();
  return instance;
}

describe("help plugin", () => {
  it("lists only what the reader can use in this chat", async () => {
    const bot = await host();
    const [reply] = await bot.receive("/help");
    const markdown = markdownOf(reply?.content);
    expect(markdown).toContain("### 测试机器人");
    expect(markdown).toContain("功能：工具");
    expect(markdown).not.toContain("秘密");
    await bot.stop();
  });

  it("filters commands and subcommands by role", async () => {
    const bot = await host();
    const member = markdownOf((await bot.receive("/help tools"))[0]?.content);
    expect(member).toContain("/echo");
    expect(member).not.toContain("/admin");

    const admin = markdownOf(
      (await bot.receive("/help admin", { role: "admin" }))[0]?.content
    );
    expect(admin).toContain("/admin status");
    expect(admin).not.toContain("/admin wipe");
    await bot.stop();
  });

  it("answers a bare subcommand-only command through the help service", async () => {
    const bot = await host();
    const [reply] = await bot.receive("/admin", { role: "admin" });
    const markdown = markdownOf(reply?.content);
    expect(markdown).toContain("# `/admin`");
    expect(markdown).not.toContain("wipe");
    await bot.stop();
  });

  it("serves other plugins and opens on a bare mention", async () => {
    let rendered: unknown;
    const consumer = definePlugin({
      name: "consumer",
      version: "1.0.0",
      apiVersion: PLUGIN_API_VERSION,
      help: { listed: false },
      setup(context) {
        context.commands.register({
          name: "probe",
          description: "调用帮助服务",
          async execute(command) {
            rendered = await context.services
              .get(helpService)
              .render(command.message, "echo");
          }
        });
      }
    });
    const bot = await host();
    await bot.load(consumer);
    await bot.receive("/probe");
    expect(markdownOf(rendered)).toContain("# `/echo`");

    const [mention] = await bot.receive("<@!bot>", {
      scope: "group",
      botMentioned: true
    });
    expect(markdownOf(mention?.content)).toContain("### 测试机器人");
    await bot.stop();
  });
});

describe("parseHelpConfig", () => {
  it("defaults and validates the title", () => {
    expect(parseHelpConfig(undefined)).toEqual({ title: "功能导航" });
    expect(parseHelpConfig({ title: " UMX " })).toEqual({ title: "UMX" });
    expect(() => parseHelpConfig({ title: "" })).toThrow();
    expect(() => parseHelpConfig({ title: 1 })).toThrow();
  });
});

describe("isMentionOnly", () => {
  it("accepts empty QQ mention payloads and rejects commands", () => {
    expect(isMentionOnly("")).toBe(true);
    expect(isMentionOnly("<@!bot-openid_123> ​")).toBe(true);
    expect(isMentionOnly("@UMX_bot")).toBe(true);
    expect(isMentionOnly("@UMX_bot /ping")).toBe(false);
    expect(isMentionOnly("/ping")).toBe(false);
  });
});
