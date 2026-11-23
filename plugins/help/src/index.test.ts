import type {
  CommandSummary,
  NavigationPageSummary,
  PluginHelpSummary,
  RichMessageContent
} from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { isMentionOnly, renderHelp } from "./index.js";

function keyboardCommands(content: RichMessageContent): string[] {
  const keyboard = content.keyboard;
  if (!keyboard || !("rows" in keyboard)) {
    return [];
  }
  return keyboard.rows
    .flat()
    .flatMap((button) => (button.action === "command" ? [button.data] : []));
}

const pingPlugin: PluginHelpSummary = {
  name: "ping",
  title: "状态检查",
  description: "检查机器人状态",
  order: -50,
  listed: true
};

const adminPlugin: PluginHelpSummary = {
  name: "admin",
  title: "管理",
  order: 10,
  listed: true
};

const helpPlugin: PluginHelpSummary = {
  name: "help",
  title: "帮助",
  order: 0,
  listed: false
};

const pages: NavigationPageSummary[] = [
  {
    id: "ping",
    plugin: pingPlugin,
    title: "状态检查",
    description: "检查机器人状态",
    order: -50,
    items: [
      {
        id: "ping",
        label: "在线状态",
        commandName: "ping",
        command: "/ping",
        description: "检查机器人是否在线",
        featured: true,
        scopes: ["group", "direct", "guild"],
        surfaces: ["message"]
      }
    ]
  },
  {
    id: "admin",
    plugin: adminPlugin,
    title: "管理",
    order: 10,
    items: [
      {
        id: "reload",
        label: "重载",
        commandName: "reload",
        command: "/reload",
        permission: "admin",
        scopes: ["group"],
        surfaces: ["message"]
      }
    ]
  }
];

const commands: CommandSummary[] = [
  {
    name: "help",
    invocation: "/help",
    description: "显示帮助",
    aliases: ["帮助"],
    aliasInvocations: ["/帮助"],
    permission: "member",
    plugin: helpPlugin,
    usage: "/help [插件或命令]",
    examples: [],
    hidden: false
  },
  {
    name: "ping",
    invocation: "/ping",
    description: "检查机器人是否在线",
    aliases: ["状态"],
    aliasInvocations: ["/状态"],
    permission: "member",
    plugin: pingPlugin,
    usage: "/ping",
    examples: [{ command: "/ping", description: "检查在线状态" }],
    hidden: false
  }
];

function render(overrides: Partial<Parameters<typeof renderHelp>[0]> = {}) {
  return renderHelp({
    pages,
    commands,
    scope: "group",
    role: "member",
    helpCommand: "/help",
    ...overrides
  });
}

describe("renderHelp", () => {
  it("renders featured commands and plugin page buttons", () => {
    const result = render();
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }

    expect(result.markdown).toContain("# UMX Bot 导航");
    expect(result.markdown).toContain("/ping");
    expect(keyboardCommands(result)).toEqual(["/ping", "/help ping"]);
    expect(result.markdown).not.toContain("/help help");
  });

  it("renders a plugin page and filters by role", () => {
    expect(render({ query: "admin" })).toBe("没有找到可用的插件或命令：admin");
    const result = render({ role: "admin", query: "admin" });
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }
    expect(keyboardCommands(result)).toEqual(["/reload", "/help"]);
  });

  it("renders command metadata in one consistent format", () => {
    const result = render({ query: "ping" });
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }
    expect(result.markdown).toContain("## 命令帮助");
    expect(result.markdown).toContain("用法：`/ping`");
    expect(result.markdown).toContain("别名：`/状态`");
    expect(result.markdown).toContain("`/ping` — 检查在线状态");
  });

  it("labels bot-owner-only commands apart from group owner ones", () => {
    const pluginCommand: CommandSummary = {
      ...commands[1],
      name: "plugin",
      invocation: "/plugin",
      description: "管理运行中的插件",
      aliases: [],
      aliasInvocations: [],
      permission: "owner",
      botOwnerOnly: true,
      usage: "/plugin",
      examples: []
    } as CommandSummary;
    const result = render({
      role: "owner",
      query: "plugin",
      commands: [...commands, pluginCommand]
    });
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }
    expect(result.markdown).toContain("权限：仅机器人主人");
    expect(result.markdown).not.toContain("权限：群主");
  });

  it("automatically lists commands without a navigation page", () => {
    const commandOnly: CommandSummary = {
      name: "echo",
      invocation: "/echo",
      description: "复读文本",
      aliases: [],
      aliasInvocations: [],
      permission: "member",
      plugin: {
        name: "utility",
        title: "实用工具",
        description: "常用文本工具",
        order: 0,
        listed: true
      },
      usage: "/echo",
      examples: [],
      hidden: false
    };
    const root = render({
      scope: "direct",
      commands: [...commands, commandOnly]
    });
    expect(typeof root).toBe("object");
    if (typeof root === "string") {
      throw new Error("expected rich navigation");
    }
    expect(keyboardCommands(root)).toContain("/help utility");

    const detail = render({
      scope: "direct",
      query: "echo",
      commands: [...commands, commandOnly]
    });
    expect(typeof detail).toBe("object");
    if (typeof detail === "string") {
      throw new Error("expected rich navigation");
    }
    expect(detail.markdown).toContain("### `/echo`");
    expect(detail.markdown).toContain("# 实用工具");
  });

  it("uses the framework-formatted help command", () => {
    const result = render({ helpCommand: "!help" });
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }
    expect(keyboardCommands(result)).toContain("!help ping");
    expect(result.markdown).toContain("`!help <插件或命令>`");
  });
});

describe("isMentionOnly", () => {
  it("accepts empty QQ mention payloads and rejects commands", () => {
    expect(isMentionOnly("")).toBe(true);
    expect(isMentionOnly("<@!bot-openid_123> \u200b")).toBe(true);
    expect(isMentionOnly("@UMX_bot")).toBe(true);
    expect(isMentionOnly("@UMX_bot /ping")).toBe(false);
    expect(isMentionOnly("/ping")).toBe(false);
  });
});

describe("help for command v2", () => {
  const command = {
    name: "calc",
    invocation: "/calc",
    description: "calculator",
    aliases: [],
    aliasInvocations: [],
    permission: "member" as const,
    plugin: { name: "calc", title: "calc", order: 0, listed: true },
    usage: "/calc",
    examples: [],
    hidden: false,
    subcommands: [
      {
        name: "add",
        invocation: "/calc add",
        description: "add numbers",
        aliases: [],
        permission: "member" as const,
        usage: "/calc add <a> <b>",
        examples: [],
        hidden: false
      },
      {
        name: "reset",
        invocation: "/calc reset",
        description: "admin reset",
        aliases: [],
        permission: "admin" as const,
        usage: "/calc reset",
        examples: [],
        hidden: false
      }
    ]
  };

  const render = (
    role: "member" | "admin",
    scope: "group" | "direct",
    scoped = false
  ) => {
    const content = renderHelp({
      pages: [],
      commands: [scoped ? { ...command, scopes: ["group" as const] } : command],
      scope,
      role,
      helpCommand: "/help",
      query: "calc"
    });
    return typeof content === "string"
      ? content
      : `${content.text ?? ""}\n${content.markdown ?? ""}`;
  };

  it("lists only the subcommands the caller may use", () => {
    expect(render("member", "group")).toContain("/calc add <a> <b>");
    expect(render("member", "group")).not.toContain("/calc reset");
    expect(render("admin", "group")).toContain("/calc reset");
  });

  it("hides commands that do not work in the current chat", () => {
    expect(render("member", "direct", true)).not.toContain("/calc add");
    expect(render("member", "group", true)).toContain("/calc add");
  });
});
