import type { NavigationPageSummary } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { isMentionOnly, renderNavigation } from "./index.js";

const pages: NavigationPageSummary[] = [
  {
    id: "ping",
    plugin: "ping",
    title: "状态检查",
    description: "检查机器人状态",
    items: [
      {
        id: "ping",
        label: "在线状态",
        command: "/ping",
        description: "检查机器人是否在线",
        featured: true,
        scopes: ["group", "direct", "guild"]
      }
    ]
  },
  {
    id: "admin",
    plugin: "admin",
    title: "管理",
    items: [
      {
        id: "reload",
        label: "重载",
        command: "/reload",
        permission: "admin",
        scopes: ["group"]
      }
    ]
  }
];

describe("renderNavigation", () => {
  it("renders featured commands and plugin page buttons", () => {
    const result = renderNavigation(pages, "group", "member");
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }

    expect(result.markdown).toContain("# UMX Bot 导航");
    expect(result.markdown).toContain("/ping");
    expect(
      result.keyboard?.rows.flat().map((button) => button.command)
    ).toEqual(["/ping", "/help ping"]);
  });

  it("renders a plugin page and filters by role", () => {
    expect(renderNavigation(pages, "group", "member", "admin")).toBe(
      "没有找到可用的插件导航页：admin"
    );
    const result = renderNavigation(pages, "group", "admin", "admin");
    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("expected rich navigation");
    }
    expect(result.keyboard?.rows.flat().map((button) => button.command)).toEqual(
      ["/reload", "/help"]
    );
  });
});

describe("isMentionOnly", () => {
  it("accepts empty QQ mention payloads and rejects commands", () => {
    expect(isMentionOnly("")).toBe(true);
    expect(isMentionOnly("<@!123456> \u200b")).toBe(true);
    expect(isMentionOnly("@UMX_bot")).toBe(true);
    expect(isMentionOnly("@UMX_bot /ping")).toBe(false);
    expect(isMentionOnly("/ping")).toBe(false);
  });
});
