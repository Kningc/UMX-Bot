import type {
  CommandSummary,
  NavigationPageSummary,
  PluginHelpSummary,
  RichMessageContent
} from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { renderHelp } from "./index.js";
import { resolveHelp } from "./resolve.js";

function plugin(
  name: string,
  overrides: Partial<PluginHelpSummary> = {}
): PluginHelpSummary {
  return { name, title: name, order: 0, listed: true, ...overrides };
}

function command(
  name: string,
  owner: PluginHelpSummary,
  overrides: Partial<CommandSummary> = {}
): CommandSummary {
  return {
    name,
    invocation: `/${name}`,
    description: `${name} description`,
    aliases: [],
    aliasInvocations: [],
    permission: "member",
    plugin: owner,
    usage: `/${name}`,
    examples: [],
    hidden: false,
    ...overrides
  };
}

const ping = plugin("ping", {
  title: "状态检查",
  description: "检查机器人状态",
  order: -50
});
const acl = plugin("access-admin", { title: "访问控制", order: 10 });
const hidden = plugin("help", { title: "帮助", listed: false });

const pages: NavigationPageSummary[] = [
  {
    id: "ping",
    plugin: ping,
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
        scopes: ["group", "direct"],
        surfaces: ["message"]
      },
      {
        id: "menu-only",
        label: "菜单入口",
        commandName: "ping",
        command: "/ping",
        scopes: ["group", "direct"],
        surfaces: ["menu"]
      }
    ]
  }
];

const commands: CommandSummary[] = [
  command("help", hidden),
  command("ping", ping, {
    aliases: ["状态"],
    aliasInvocations: ["/状态"],
    examples: [{ command: "/ping", description: "检查在线状态" }]
  }),
  command("acl", acl, {
    description: "在当前聊天开关插件或命令",
    permission: "admin",
    usage: "/acl",
    subcommands: [
      {
        name: "disable",
        invocation: "/acl disable",
        description: "在当前聊天停用插件或命令",
        aliases: ["off"],
        permission: "admin",
        usage: "/acl disable <插件或命令>",
        examples: [],
        hidden: false
      },
      {
        name: "block",
        invocation: "/acl block",
        description: "封禁用户",
        aliases: [],
        permission: "owner",
        usage: "/acl block <用户>",
        examples: [],
        hidden: false
      }
    ]
  })
];

function rich(content: ReturnType<typeof renderHelp>): RichMessageContent {
  if (typeof content === "string") {
    throw new Error(`expected rich content, got: ${content}`);
  }
  return content;
}

function buttons(content: RichMessageContent): string[] {
  const keyboard = content.keyboard;
  if (!keyboard || !("rows" in keyboard)) {
    return [];
  }
  return keyboard.rows
    .flat()
    .flatMap((button) => (button.action === "command" ? [button.data] : []));
}

function render(
  query?: string,
  overrides: Partial<{
    commands: CommandSummary[];
    pages: NavigationPageSummary[];
  }> = {}
) {
  return renderHelp({
    pages: overrides.pages ?? pages,
    commands: overrides.commands ?? commands,
    helpCommand: "/help",
    prefix: "/",
    title: "UMX Bot",
    ...(query !== undefined ? { query } : {})
  });
}

describe("buildCatalog", () => {
  it("groups commands into sections and skips unlisted plugins", () => {
    const catalog = buildCatalog(pages, commands);
    expect(catalog.sections.map((section) => section.id)).toEqual([
      "ping",
      "access-admin"
    ]);
    expect(catalog.sections[0]?.items.map((item) => item.id)).toEqual(["ping"]);
    expect(catalog.featured.map((item) => item.id)).toEqual(["ping"]);
    expect(catalog.sections[1]?.commands.map((entry) => entry.name)).toEqual([
      "acl"
    ]);
  });
});

describe("resolveHelp", () => {
  const catalog = buildCatalog(pages, commands);
  const kind = (query?: string) => resolveHelp(catalog, query, "/").kind;

  it("opens the main navigation and its pages", () => {
    expect(resolveHelp(catalog, undefined, "/")).toEqual({
      kind: "home",
      page: 1
    });
    expect(resolveHelp(catalog, "3", "/")).toEqual({ kind: "home", page: 3 });
  });

  it("finds commands by name, alias or prefixed name", () => {
    expect(kind("ping")).toBe("command");
    expect(kind("状态")).toBe("command");
    expect(kind("/ping")).toBe("command");
    expect(kind("PING")).toBe("command");
  });

  it("finds subcommands by name or alias", () => {
    const view = resolveHelp(catalog, "acl off", "/");
    expect(view.kind).toBe("subcommand");
    expect(view.kind === "subcommand" && view.subcommand.name).toBe("disable");
    expect(kind("acl nonsense")).toBe("command");
  });

  it("finds sections by id, plugin name or title", () => {
    expect(kind("access-admin")).toBe("section");
    expect(kind("访问控制")).toBe("section");
  });

  it("opens the only substring match and suggests when several match", () => {
    expect(kind("访问")).toBe("section");
    const view = resolveHelp(catalog, "a", "/");
    expect(view.kind).toBe("notFound");
    expect(view.kind === "notFound" && view.suggestions.length).toBeGreaterThan(
      1
    );
    expect(resolveHelp(catalog, "zzz", "/")).toEqual({
      kind: "notFound",
      query: "zzz",
      suggestions: []
    });
  });
});

describe("renderHelp", () => {
  it("renders featured actions and sections on the main navigation", () => {
    const result = rich(render());
    expect(result.markdown).toBe(
      [
        "### UMX Bot",
        "常用：**在线状态** `/ping`",
        "功能：状态检查 · 访问控制",
        "发送 `/help 名称` 查看用法"
      ].join("\n")
    );
    expect(buttons(result)).toEqual([
      "/ping",
      "/help ping",
      "/help access-admin"
    ]);
    expect(result.markdown).not.toContain("/help help");
  });

  it("keeps the plain text in step with the Markdown", () => {
    const result = rich(render("acl"));
    expect(result.text).toContain("用法：/acl");
    expect(result.text).toContain("子命令：");
    expect(result.text).not.toMatch(/[`*#]/u);
  });

  it("labels roles accurately", () => {
    const markdown = rich(render("acl")).markdown ?? "";
    expect(markdown).toContain("权限：管理员及以上");
    expect(rich(render("acl block")).markdown).toContain(
      "权限：群主或机器人主人"
    );
    expect(markdown).not.toContain("群主\n");
  });

  it("shows a single-command section in full", () => {
    const result = rich(render("状态检查"));
    expect(result.markdown).toContain("## `/ping`");
    expect(result.markdown).toContain("别名：`/状态`");
    expect(result.markdown).toContain("`/ping` — 检查在线状态");
    expect(buttons(result)).toEqual(["/ping", "/help"]);
  });

  it("links subcommands from a command page", () => {
    const result = rich(render("acl"));
    expect(buttons(result)).toEqual([
      "/help acl disable",
      "/help acl block",
      "/help"
    ]);
    const sub = rich(render("acl disable"));
    expect(sub.markdown).toContain("别名：`/acl off`");
    expect(buttons(sub)).toEqual(["/help acl", "/help"]);
  });

  it("pages the buttons instead of dropping sections", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      command(`cmd${index}`, plugin(`p${String(index).padStart(2, "0")}`))
    );
    const first = rich(render(undefined, { pages: [], commands: many }));
    expect(buttons(first)).toHaveLength(9);
    expect(buttons(first).at(-1)).toBe("/help 2");
    expect(first.markdown).toContain("`/help 2` 看更多按钮");
    expect(first.markdown).toContain("p11");

    const second = rich(render("2", { pages: [], commands: many }));
    expect(buttons(second)).toEqual([
      "/help p08",
      "/help p09",
      "/help p10",
      "/help p11",
      "/help 1"
    ]);
    expect(buttons(rich(render("99", { pages: [], commands: many })))).toEqual(
      buttons(second)
    );
    expect(second.markdown).not.toContain("看更多按钮");
  });

  it("keeps the main navigation short however many plugins there are", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      command(`cmd${index}`, plugin(`p${index}`))
    );
    const markdown = rich(
      render(undefined, { pages: [], commands: many })
    ).markdown;
    expect(markdown?.split("\n").length).toBeLessThanOrEqual(4);
  });

  it("truncates long button labels visibly", () => {
    const long = plugin("long", { title: "一个名字特别特别长的插件" });
    const result = rich(
      render(undefined, { pages: [], commands: [command("x", long)] })
    );
    const keyboard = result.keyboard;
    const label =
      keyboard && "rows" in keyboard ? keyboard.rows[0]?.[0]?.label : undefined;
    expect(label).toBe("一个名字特别特别长…");
  });

  it("says when nothing is available or nothing matched", () => {
    expect(render(undefined, { pages: [], commands: [] })).toBe(
      "当前没有你可以使用的功能。"
    );
    const missing = rich(render("zzz"));
    expect(missing.markdown).toContain("没有找到「zzz」");
    expect(buttons(missing)).toEqual(["/help"]);
  });
});
