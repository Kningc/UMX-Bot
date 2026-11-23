import type {
  CommandSummary,
  Logger,
  NavigationItemSummary,
  NavigationPageSummary
} from "@umx-bot/plugin-sdk";
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
      length + ((character.codePointAt(0) ?? 0) < 0x80 ? 1 : 2),
    0
  );
}

function assertLength(value: string, maximum: number, subject: string): void {
  if (displayLength(value) > maximum) {
    throw new Error(`${subject} exceeds QQ display-length limit ${maximum}`);
  }
}

const PANEL_NAME_LIMIT = 14;
const PANEL_DESCRIPTION_LIMIT = 30;
const PANEL_ITEM_LIMIT = 20;

/** Cuts `value` to `maximum` display columns, ending with "…" when cut. */
function truncateDisplay(value: string, maximum: number): string {
  if (displayLength(value) <= maximum) {
    return value;
  }
  let result = "";
  for (const character of value) {
    if (displayLength(`${result}${character}…`) > maximum) {
      break;
    }
    result += character;
  }
  return `${result}…`;
}

/** At most this many commands from any one plugin, so none can crowd out the rest. */
const PANEL_PLUGIN_LIMIT = 5;
/** Slots kept for admin commands when the panel overflows. */
const PANEL_ADMIN_RESERVE = 5;

export interface QqCommandPanelSkip {
  command: string;
  reason: string;
  /**
   * `plugin-limit` is the plugin's own overflow and expected for plugins
   * with many commands; `panel-limit` and `name` lose a command the plugin
   * did not ask to drop.
   */
  kind: "name" | "plugin-limit" | "panel-limit";
}

export interface QqCommandPanel {
  panel: QqPanel;
  /** Commands left out, with why, so the caller can log them. */
  skipped: QqCommandPanelSkip[];
}

/**
 * The QQ command panel lists commands: picking one puts it in the input box
 * for the user to finish. So it is built from registered commands, one entry
 * per top-level command, rather than from navigation shortcuts.
 *
 * Left out: hidden and bot-owner-only commands (group admins would see them
 * but could not run them), `panel: false` and other chats' commands. Each
 * plugin then contributes at most 5, preferring `panel: true`, then commands
 * with a featured navigation item, then any navigation item, then everyone's
 * over admin ones. The
 * panel lists everyone's commands before admin ones (marked `only_admin`),
 * preferred ones first, then by the plugin's navigation order. Past 20, admin
 * commands keep up to 5 slots and the tails are dropped.
 */
export function projectCommandPanel(
  pages: readonly NavigationPageSummary[],
  commands: readonly CommandSummary[],
  scope: PanelScope
): QqCommandPanel {
  const chatScope = scope === "c2c" ? "direct" : "group";
  const featured = new Set<string>();
  const navigated = new Set<string>();
  const pluginOrder = new Map<string, number>();
  for (const page of pages) {
    if (!pluginOrder.has(page.plugin.name)) {
      pluginOrder.set(page.plugin.name, page.order ?? page.plugin.order);
    }
    for (const item of page.items) {
      navigated.add(item.commandName);
      if (item.featured) {
        featured.add(item.commandName);
      }
    }
  }
  const skipped: QqCommandPanelSkip[] = [];
  const eligible = commands.filter((command) => {
    if (command.hidden || command.botOwnerOnly || command.panel === false) {
      return false;
    }
    if (command.scopes && !command.scopes.includes(chatScope)) {
      return false;
    }
    if (displayLength(command.name) > PANEL_NAME_LIMIT) {
      skipped.push({
        command: command.name,
        reason: `name exceeds ${PANEL_NAME_LIMIT} display columns`,
        kind: "name"
      });
      return false;
    }
    return true;
  });

  const isAdmin = (command: CommandSummary) => command.permission !== "member";
  const isPreferred = (command: CommandSummary) =>
    command.panel === true || featured.has(command.name);
  const compare =
    (keys: (command: CommandSummary) => number[]) =>
    (left: CommandSummary, right: CommandSummary) => {
      const a = keys(left);
      const b = keys(right);
      for (let index = 0; index < a.length; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return left.name.localeCompare(right.name);
    };

  const byPlugin = new Map<string, CommandSummary[]>();
  for (const command of eligible) {
    const list = byPlugin.get(command.plugin.name) ?? [];
    list.push(command);
    byPlugin.set(command.plugin.name, list);
  }
  const selected: CommandSummary[] = [];
  for (const list of byPlugin.values()) {
    list.sort(
      compare((command) => [
        command.panel === true ? 0 : 1,
        featured.has(command.name) ? 0 : 1,
        // A command a plugin gives a navigation entry is one of its front doors.
        navigated.has(command.name) ? 0 : 1,
        isAdmin(command) ? 1 : 0
      ])
    );
    selected.push(...list.slice(0, PANEL_PLUGIN_LIMIT));
    for (const command of list.slice(PANEL_PLUGIN_LIMIT)) {
      skipped.push({
        command: command.name,
        reason: `plugin "${command.plugin.name}" shows at most ${PANEL_PLUGIN_LIMIT} commands`,
        kind: "plugin-limit"
      });
    }
  }
  selected.sort(
    compare((command) => [
      isAdmin(command) ? 1 : 0,
      isPreferred(command) ? 0 : 1,
      pluginOrder.get(command.plugin.name) ?? command.plugin.order
    ])
  );

  const members = selected.filter((command) => !isAdmin(command));
  const admins = selected.filter(isAdmin);
  const memberSlots = Math.min(
    members.length,
    PANEL_ITEM_LIMIT - Math.min(admins.length, PANEL_ADMIN_RESERVE)
  );
  const kept = [
    ...members.slice(0, memberSlots),
    ...admins.slice(0, PANEL_ITEM_LIMIT - memberSlots)
  ];
  for (const command of selected) {
    if (!kept.includes(command)) {
      skipped.push({
        command: command.name,
        reason: `panel holds at most ${PANEL_ITEM_LIMIT} commands`,
        kind: "panel-limit"
      });
    }
  }

  return {
    panel: {
      items: kept.map((command) => ({
        type: "command" as const,
        name: command.name,
        ...(command.description.trim()
          ? {
              desc: truncateDisplay(
                command.description.trim(),
                PANEL_DESCRIPTION_LIMIT
              )
            }
          : {}),
        ...(isAdmin(command) ? { only_admin: true } : {})
      })),
      remark: `${MANAGED_REMARK_PREFIX}${scope}`
    },
    skipped
  };
}

function commandName(item: NavigationItemSummary): string {
  return `${item.commandName}${item.args ? ` ${item.args}` : ""}`;
}

function projectMenu(pages: readonly NavigationPageSummary[]): {
  items: QqMenuItem[];
} {
  const items = pages.flatMap((page): QqMenuItem[] => {
    const entries = page.items.filter(
      (item) => item.surfaces.includes("menu") && item.scopes.includes("direct")
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

/**
 * With `commands`, panels list commands (`projectCommandPanel`); without,
 * they fall back to navigation items marked `panel`, for older hosts.
 */
export function projectQqNavigation(
  pages: readonly NavigationPageSummary[],
  commands?: readonly CommandSummary[]
): QqNavigationProjection {
  return {
    menu: projectMenu(pages),
    panels: {
      c2c: commands
        ? projectCommandPanel(pages, commands, "c2c").panel
        : projectPanel(pages, "c2c"),
      group: commands
        ? projectCommandPanel(pages, commands, "group").panel
        : projectPanel(pages, "group")
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
    pages: readonly NavigationPageSummary[],
    commands?: readonly CommandSummary[]
  ): Promise<QqNavigationSyncResult> {
    const desired = projectQqNavigation(pages, commands);
    if (commands) {
      for (const scope of panelScopes) {
        const { skipped } = projectCommandPanel(pages, commands, scope);
        // A plugin's own overflow is routine; losing anything else is not.
        const capped = skipped.filter((entry) => entry.kind === "plugin-limit");
        const lost = skipped.filter((entry) => entry.kind !== "plugin-limit");
        if (capped.length > 0) {
          this.logger.info(
            { scope, skipped: capped },
            "QQ command panel shows a few commands per plugin; the rest are in /help"
          );
        }
        if (lost.length > 0) {
          this.logger.warn(
            { scope, skipped: lost },
            "some commands were left out of the QQ command panel"
          );
        }
      }
    }
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
      throw new Error(
        `multiple QQ panels use managed remark "${desired.remark}"`
      );
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
      throw new Error(`managed QQ ${scope} panel must use target_type=all`);
    }
    if (containsExpected(existing.panel?.items, desired.items)) {
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
