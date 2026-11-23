import type {
  CommandSummary,
  Logger,
  NavigationPageSummary
} from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  projectCommandPanel,
  projectQqNavigation,
  QqNavigationSynchronizer
} from "./navigation-sync.js";
import type { QqOpenApiClient, QqOpenApiRequest } from "./openapi/client.js";

class TestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

function pages(): NavigationPageSummary[] {
  const plugin = {
    name: "tools",
    title: "Tools",
    order: 0,
    listed: true
  };
  return [
    {
      id: "help",
      plugin,
      title: "Help",
      items: [
        {
          id: "help",
          label: "帮助",
          commandName: "help",
          command: "/help",
          description: "查看全部功能",
          scopes: ["direct", "group"],
          surfaces: ["menu", "panel"]
        }
      ]
    },
    {
      id: "tools",
      plugin,
      title: "工具",
      items: [
        {
          id: "status",
          label: "状态",
          commandName: "status",
          command: "/status",
          description: "查看状态",
          scopes: ["direct", "group"],
          surfaces: ["message", "menu", "panel"]
        },
        {
          id: "reset",
          label: "重置",
          commandName: "reset",
          command: "/reset now",
          args: "now",
          description: "重置状态",
          permission: "admin",
          scopes: ["group"],
          surfaces: ["panel"]
        }
      ]
    }
  ];
}

describe("QQ navigation projection", () => {
  it("projects plugin navigation into a menu and scoped panels", () => {
    expect(projectQqNavigation(pages())).toEqual({
      menu: {
        items: [
          { type: "send_message", name: "帮助", send_message: "/help" },
          { type: "send_message", name: "状态", send_message: "/status" }
        ]
      },
      panels: {
        c2c: {
          remark: "qq-bot-managed:c2c",
          items: [
            { type: "command", name: "help", desc: "查看全部功能" },
            { type: "command", name: "status", desc: "查看状态" }
          ]
        },
        group: {
          remark: "qq-bot-managed:group",
          items: [
            { type: "command", name: "help", desc: "查看全部功能" },
            { type: "command", name: "status", desc: "查看状态" },
            {
              type: "command",
              name: "reset now",
              desc: "重置状态",
              only_admin: true
            }
          ]
        }
      }
    });
  });

  it("rejects values beyond QQ limits before making requests", () => {
    const invalid = pages();
    invalid[0]!.items[0]!.label = "这是一个过长的一级菜单";
    expect(() => projectQqNavigation(invalid)).toThrow(
      "QQ display-length limit"
    );
  });
});

describe("QqNavigationSynchronizer", () => {
  it("does not mutate matching live configuration", async () => {
    const desired = projectQqNavigation(pages());
    const requests: QqOpenApiRequest[] = [];
    const openApi = {
      async request<T>(request: QqOpenApiRequest): Promise<T> {
        requests.push(request);
        if (request.path === "/v2/menu") {
          return { menu: desired.menu, version: 5 } as T;
        }
        const scope = request.path.includes("scope=c2c") ? "c2c" : "group";
        return {
          records: [
            {
              panel_id: `panel-${scope}`,
              scope,
              target_type: "all",
              panel: desired.panels[scope]
            }
          ]
        } as T;
      }
    } as unknown as QqOpenApiClient;

    const result = await new QqNavigationSynchronizer(
      openApi,
      new TestLogger()
    ).sync(pages());

    expect(result).toEqual({
      menu: "unchanged",
      panels: { c2c: "unchanged", group: "unchanged" }
    });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET"
    ]);
  });

  it("updates owned resources and creates a missing panel", async () => {
    const requests: QqOpenApiRequest[] = [];
    const openApi = {
      async request<T>(request: QqOpenApiRequest): Promise<T> {
        requests.push(request);
        if (request.method !== "GET") return {} as T;
        if (request.path === "/v2/menu") return { menu: { items: [] } } as T;
        if (request.path.includes("scope=c2c")) {
          return {
            records: [
              {
                panel_id: "owned-c2c",
                target_type: "all",
                panel: { remark: "qq-bot-managed:c2c", items: [] }
              }
            ]
          } as T;
        }
        return { records: [] } as T;
      }
    } as unknown as QqOpenApiClient;

    const result = await new QqNavigationSynchronizer(
      openApi,
      new TestLogger()
    ).sync(pages());

    expect(result).toEqual({
      menu: "updated",
      panels: { c2c: "updated", group: "created" }
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v2/menu",
      "PUT /v2/menu",
      "GET /v2/panels?scope=c2c&limit=50",
      "PUT /v2/panels/owned-c2c",
      "GET /v2/panels?scope=group&limit=50",
      "POST /v2/panels"
    ]);
  });
});

function commandSummary(
  name: string,
  overrides: Partial<CommandSummary> = {}
): CommandSummary {
  return {
    name,
    invocation: `/${name}`,
    description: `${name} 的说明`,
    aliases: [],
    aliasInvocations: [],
    permission: "member",
    plugin: { name: "tools", title: "Tools", order: 0, listed: true },
    usage: `/${name}`,
    examples: [],
    hidden: false,
    ...overrides
  };
}

describe("QQ command panel", () => {
  const helpPlugin = { name: "help", title: "帮助", order: 0, listed: false };
  const navigation: NavigationPageSummary[] = [
    {
      id: "help",
      plugin: helpPlugin,
      title: "帮助",
      order: -100,
      items: [
        {
          id: "help",
          label: "帮助",
          commandName: "help",
          command: "/help",
          featured: true,
          scopes: ["direct", "group"],
          surfaces: ["menu", "panel"]
        }
      ]
    },
    {
      id: "tools",
      plugin: { name: "tools", title: "Tools", order: 0, listed: true },
      title: "工具",
      order: 0,
      items: [
        {
          id: "ai",
          label: "询问 AI",
          commandName: "ai",
          command: "/ai",
          featured: true,
          scopes: ["group"],
          surfaces: ["message"]
        }
      ]
    }
  ];

  it("lists commands: help, featured, the rest, then admin ones", () => {
    const { panel, skipped } = projectCommandPanel(
      navigation,
      [
        commandSummary("acl", { permission: "admin" }),
        commandSummary("zeta"),
        commandSummary("ai"),
        commandSummary("help", { plugin: helpPlugin }),
        commandSummary("secret", { hidden: true }),
        commandSummary("plugin", { permission: "owner", botOwnerOnly: true }),
        commandSummary("dm", { scopes: ["direct"] })
      ],
      "group"
    );
    expect(panel.items.map((item) => item.name)).toEqual([
      "help",
      "ai",
      "zeta",
      "acl"
    ]);
    expect(panel.items.at(-1)).toMatchObject({ only_admin: true });
    expect(panel.items[0]).not.toHaveProperty("only_admin");
    expect(panel.remark).toBe("qq-bot-managed:group");
    expect(skipped).toEqual([]);
  });

  it("keeps commands to their chats", () => {
    const { panel } = projectCommandPanel(
      navigation,
      [commandSummary("dm", { scopes: ["direct"] }), commandSummary("ai")],
      "c2c"
    );
    expect(panel.items.map((item) => item.name)).toEqual(["ai", "dm"]);
  });

  it("truncates long descriptions instead of failing", () => {
    const { panel } = projectCommandPanel(
      navigation,
      [
        commandSummary("xiuxian", {
          description: "进入游戏、创建角色或执行任意自由行动"
        })
      ],
      "group"
    );
    expect(panel.items[0]?.desc).toBe("进入游戏、创建角色或执行任意…");
  });

  it("drops the tail past 20 commands and reports what it skipped", () => {
    const many = Array.from({ length: 23 }, (_, index) =>
      commandSummary(`c${String(index).padStart(2, "0")}`)
    );
    const { panel, skipped } = projectCommandPanel(
      navigation,
      [...many, commandSummary("averyveryverylongname")],
      "group"
    );
    expect(panel.items).toHaveLength(20);
    expect(skipped.map((entry) => entry.command)).toEqual([
      "averyveryverylongname",
      "c20",
      "c21",
      "c22"
    ]);
  });

  it("is what the projection uses once commands are known", () => {
    const projection = projectQqNavigation(navigation, [commandSummary("ai")]);
    expect(projection.panels.group.items.map((item) => item.name)).toEqual([
      "ai"
    ]);
    // Without commands, older hosts keep the navigation-based panel.
    expect(
      projectQqNavigation(navigation).panels.group.items.map(
        (item) => item.name
      )
    ).toEqual(["help"]);
  });
});
