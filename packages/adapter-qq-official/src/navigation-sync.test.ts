import type {
  Logger,
  NavigationPageSummary
} from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { QqOpenApiClient, QqOpenApiRequest } from "./openapi/client.js";
import {
  projectQqNavigation,
  QqNavigationSynchronizer
} from "./navigation-sync.js";

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
