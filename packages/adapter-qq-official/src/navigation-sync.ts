import type {
  Logger,
  NavigationItemSummary,
  NavigationPageSummary
} from "@qq-bot/plugin-sdk";
import type { QqOpenApiClient } from "./openapi/client.js";

const MANAGED_REMARK_PREFIX = "qq-bot-managed:";
const panelScopes = ["c2c", "group"] as const;
type PanelScope = (typeof panelScopes)[number];

interface QqMenuItem {
  type: "send_message" | "menu";
  name: string;
  send_message?: string;
  sub_menu_items?: QqSubMenuItem[];
}

interface QqSubMenuItem {
  type: "send_message";
  name: string;
  send_message: string;
}

interface QqPanelItem {
  type: "command";
  name: string;
  desc?: string;
  only_admin?: boolean;
}

interface QqPanel {
  items: QqPanelItem[];
  remark: string;
}

interface QqPanelRecord {
  panel_id?: string;
  scope?: string;
  target_type?: string;
  panel?: QqPanel;
  version?: number;
}

interface QqPanelList {
  records?: QqPanelRecord[];
}

export interface QqNavigationProjection {
  menu: { items: QqMenuItem[] };
  panels: Record<PanelScope, QqPanel>;
}

export interface QqNavigationSyncResult {
  menu: "unchanged" | "updated";
  panels: Record<PanelScope, "unchanged" | "created" | "updated" | "deleted">;
}

function displayLength(value: string): number {
  return [...value].reduce(
    (length, character) =>
      length + (/^[\x00-\x7f]$/u.test(character) ? 1 : 2),
    0
  );
}

function assertLength(value: string, maximum: number, subject: string): void {
  if (displayLength(value) > maximum) {
    throw new Error(`${subject} exceeds QQ display-length limit ${maximum}`);
  }
}

function commandName(item: NavigationItemSummary): string {
  return `${item.commandName}${item.args ? ` ${item.args}` : ""}`;
}

function projectMenu(pages: readonly NavigationPageSummary[]): {
  items: QqMenuItem[];
} {
  const items = pages.flatMap((page): QqMenuItem[] => {
    const entries = page.items.filter(
      (item) =>
        item.surfaces.includes("menu") && item.scopes.includes("direct")
    );
    if (entries.length === 0) return [];
    if (entries.length === 1) {
      const [entry] = entries;
      assertLength(entry!.label, 10, `navigation item "${entry!.id}" label`);
      return [
        {
          type: "send_message" as const,
          name: entry!.label,
          send_message: entry!.command
        }
      ];
    }
    if (entries.length > 5) {
      throw new Error(
        `navigation page "${page.id}" exposes more than 5 QQ menu items`
      );
    }
    assertLength(page.title, 10, `navigation page "${page.id}" title`);
    const subMenuItems = entries.map((entry) => {
      assertLength(entry.label, 14, `navigation item "${entry.id}" label`);
      return {
        type: "send_message" as const,
        name: entry.label,
        send_message: entry.command
      };
    });
    return [
      {
        type: "menu" as const,
        name: page.title,
        sub_menu_items: subMenuItems
      }
    ];
  });
  if (items.length > 10) {
    throw new Error("plugins expose more than 10 top-level QQ menu items");
  }
  return { items };
}

function projectPanel(
  pages: readonly NavigationPageSummary[],
  scope: PanelScope
): QqPanel {
  const chatScope = scope === "c2c" ? "direct" : "group";
  const items = pages.flatMap((page) =>
    page.items
      .filter(
        (item) =>
          item.surfaces.includes("panel") && item.scopes.includes(chatScope)
      )
      .map((item) => {
        const name = commandName(item);
        assertLength(name, 14, `navigation item "${item.id}" panel command`);
        if (item.description) {
          assertLength(
            item.description,
            30,
            `navigation item "${item.id}" description`
          );
        }
        return {
          type: "command" as const,
          name,
          ...(item.description ? { desc: item.description } : {}),
          ...(item.permission && item.permission !== "member"
            ? { only_admin: true }
            : {})
        };
      })
  );
  if (items.length > 20) {
    throw new Error(`plugins expose more than 20 QQ ${scope} panel items`);
  }
  return {
    items,
    remark: `${MANAGED_REMARK_PREFIX}${scope}`
  };
}

export function projectQqNavigation(
  pages: readonly NavigationPageSummary[]
): QqNavigationProjection {
  return {
    menu: projectMenu(pages),
    panels: {
      c2c: projectPanel(pages, "c2c"),
      group: projectPanel(pages, "group")
    }
  };
}

function containsExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsExpected(actual[index], value))
    );
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) =>
      containsExpected(actualRecord[key], value)
    );
  }
  return Object.is(actual, expected);
}

export class QqNavigationSynchronizer {
  public constructor(
    private readonly openApi: QqOpenApiClient,
    private readonly logger: Logger
  ) {}

  public async sync(
    pages: readonly NavigationPageSummary[]
  ): Promise<QqNavigationSyncResult> {
    const desired = projectQqNavigation(pages);
    const menu = await this.syncMenu(desired.menu);
    const panels = {
      c2c: await this.syncPanel("c2c", desired.panels.c2c),
      group: await this.syncPanel("group", desired.panels.group)
    };
    const result = { menu, panels };
    this.logger.info(result, "QQ navigation synchronized");
    return result;
  }

  private async syncMenu(
    desired: QqNavigationProjection["menu"]
  ): Promise<QqNavigationSyncResult["menu"]> {
    const current = await this.openApi.request<{
      menu?: { items?: unknown[] };
    }>({
      method: "GET",
      path: "/v2/menu",
      idempotent: true
    });
    if (containsExpected(current.menu?.items, desired.items)) {
      return "unchanged";
    }
    await this.openApi.request({
      method: "PUT",
      path: "/v2/menu",
      body: { menu: desired },
      idempotent: true
    });
    return "updated";
  }

  private async syncPanel(
    scope: PanelScope,
    desired: QqPanel
  ): Promise<QqNavigationSyncResult["panels"][PanelScope]> {
    const query = new URLSearchParams({ scope, limit: "50" });
    const list = await this.openApi.request<QqPanelList>({
      method: "GET",
      path: `/v2/panels?${query}`,
      idempotent: true
    });
    const matches = (list.records ?? []).filter(
      (record) => record.panel?.remark === desired.remark
    );
    if (matches.length > 1) {
      throw new Error(`multiple QQ panels use managed remark "${desired.remark}"`);
    }
    const existing = matches[0];
    if (desired.items.length === 0) {
      if (!existing) return "unchanged";
      if (!existing.panel_id) {
        throw new Error(`managed QQ ${scope} panel has no panel_id`);
      }
      await this.openApi.request({
        method: "DELETE",
        path: `/v2/panels/${encodeURIComponent(existing.panel_id)}`,
        idempotent: true
      });
      return "deleted";
    }
    if (!existing) {
      await this.openApi.request({
        method: "POST",
        path: "/v2/panels",
        body: {
          scope,
          target_type: "all",
          panel: desired
        }
      });
      return "created";
    }
    if (existing.target_type !== "all") {
      throw new Error(
        `managed QQ ${scope} panel must use target_type=all`
      );
    }
    if (
      containsExpected(existing.panel?.items, desired.items)
    ) {
      return "unchanged";
    }
    if (!existing.panel_id) {
      throw new Error(`managed QQ ${scope} panel has no panel_id`);
    }
    await this.openApi.request({
      method: "PUT",
      path: `/v2/panels/${encodeURIComponent(existing.panel_id)}`,
      body: { panel: desired },
      idempotent: true
    });
    return "updated";
  }
}
