import type { BotKernel } from "@qq-bot/core";
import type {
  BotPlugin,
  ConversationRef,
  SettingsScope
} from "@qq-bot/plugin-sdk";
import {
  defineArgs,
  definePlugin,
  PLUGIN_API_VERSION
} from "@qq-bot/plugin-sdk";

export interface ConfigAdminOptions {
  bot: BotKernel;
}

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_KEY = /(secret|token|password|api[-_]?key)/iu;

/**
 * `/config`: inspect and edit any plugin's settings without the plugin
 * shipping its own admin command.
 *
 * Works off the kernel's settings catalog, so it handles every definition
 * made with `context.settings.define` and validates edits through the
 * plugin's own schema. Edits go to the current conversation; the `*-global`
 * variants are owner-only.
 */
export function createConfigAdminPlugin(
  options: ConfigAdminOptions
): BotPlugin {
  const { bot } = options;

  const locate = (selector: string) => {
    const [plugin = "", key] = selector.split("/");
    return bot.settings.find(plugin, key);
  };
  const conversation = (target: ConversationRef): SettingsScope => ({
    level: "conversation",
    platform: target.platform,
    scope: target.scope,
    conversationId: target.conversationId
  });

  return definePlugin({
    name: "config-admin",
    version: "0.5.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "查看和修改插件设置",
    help: {
      title: "插件设置",
      description: "查看、修改、重置各插件的会话级设置（仅管理员）",
      order: 98
    },
    setup(context) {
      const missing = (selector: string): string => {
        const known = bot.settings
          .list()
          .map((entry) =>
            entry.key === "default"
              ? entry.plugin
              : `${entry.plugin}/${entry.key}`
          );
        return `没有「${selector}」的设置。${
          known.length > 0
            ? `可用：${known.join("、")}`
            : "目前没有插件定义了设置。"
        }`;
      };

      const edit = (level: "conversation" | "global") => ({
        args: defineArgs({
          plugin: { type: "string" },
          path: { type: "string" },
          value: { type: "string", rest: true }
        }),
        async execute(command: {
          message: ConversationRef;
          parsed: { plugin: string; path: string; value: string };
          reply(content: string): Promise<unknown>;
        }) {
          const entry = locate(command.parsed.plugin);
          if (!entry) {
            await command.reply(missing(command.parsed.plugin));
            return;
          }
          const scope: SettingsScope =
            level === "global"
              ? { level: "global" }
              : conversation(command.message);
          try {
            const segments = splitPath(command.parsed.path);
            const value = parseValue(command.parsed.value);
            const next = await entry.settings.update(scope, (current) =>
              setPath(current as Record<string, unknown>, segments, value)
            );
            await command.reply(
              `已更新 ${command.parsed.plugin} ${command.parsed.path}。\n当前生效：\n${render(next)}`
            );
          } catch (error) {
            await command.reply(
              `修改失败：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      });

      const reset = (level: "conversation" | "global") => ({
        args: defineArgs({
          plugin: { type: "string" },
          path: { type: "string", optional: true }
        }),
        async execute(command: {
          message: ConversationRef;
          parsed: { plugin: string; path?: string };
          reply(content: string): Promise<unknown>;
        }) {
          const entry = locate(command.parsed.plugin);
          if (!entry) {
            await command.reply(missing(command.parsed.plugin));
            return;
          }
          const scope: SettingsScope =
            level === "global"
              ? { level: "global" }
              : conversation(command.message);
          try {
            if (command.parsed.path === undefined) {
              const removed = await entry.settings.reset(scope);
              await command.reply(
                removed ? "已恢复默认。" : "没有可重置的覆盖。"
              );
              return;
            }
            const segments = splitPath(command.parsed.path);
            await entry.settings.update(scope, (current) =>
              deletePath(current as Record<string, unknown>, segments)
            );
            await command.reply(
              `已重置 ${command.parsed.plugin} ${command.parsed.path}。`
            );
          } catch (error) {
            await command.reply(
              `重置失败：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      });

      context.commands.register({
        name: "config",
        description: "查看或修改插件设置",
        permission: "admin",
        subcommands: [
          {
            name: "list",
            description: "列出可配置的插件",
            async execute(command) {
              const entries = bot.settings.list();
              await command.reply(
                entries.length === 0
                  ? "目前没有插件定义了设置。"
                  : entries
                      .map((entry) =>
                        entry.key === "default"
                          ? entry.plugin
                          : `${entry.plugin}/${entry.key}`
                      )
                      .join("\n")
              );
            }
          },
          {
            name: "show",
            description: "查看当前聊天生效的设置及其来源层",
            args: defineArgs({ plugin: { type: "string" } }),
            async execute(command) {
              const { plugin } = command.parsed as { plugin: string };
              const entry = locate(plugin);
              if (!entry) {
                await command.reply(missing(plugin));
                return;
              }
              const inspection = await entry.settings.inspect(command.message);
              const layers = Object.entries(inspection.layers)
                .filter(
                  ([name, value]) => name !== "defaults" && value !== undefined
                )
                .map(
                  ([name, value]) => `${name}: ${JSON.stringify(mask(value))}`
                );
              await command.reply(
                [
                  `${plugin} 当前生效：`,
                  render(inspection.value),
                  layers.length > 0
                    ? `覆盖层：\n${layers.join("\n")}`
                    : "没有覆盖，全部为默认值。"
                ].join("\n")
              );
            }
          },
          {
            name: "set",
            description: "修改当前聊天的设置（值可以是 JSON）",
            usage: "<插件> <路径> <值>",
            examples: [
              {
                args: "mc timeoutMs 5000",
                description: "把 mc 插件的 timeoutMs 设为 5000"
              }
            ],
            ...edit("conversation")
          },
          {
            name: "reset",
            description: "重置当前聊天的设置（可指定路径）",
            ...reset("conversation")
          },
          {
            name: "set-global",
            description: "修改全局设置（仅 owner）",
            permission: "owner",
            ...edit("global")
          },
          {
            name: "reset-global",
            description: "重置全局设置（仅 owner）",
            permission: "owner",
            ...reset("global")
          }
        ]
      });
    }
  });
}

function splitPath(path: string): string[] {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => UNSAFE_SEGMENTS.has(segment))
  ) {
    throw new Error(`路径「${path}」不合法`);
  }
  return segments;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function setPath(
  current: Record<string, unknown>,
  segments: string[],
  value: unknown
): Record<string, unknown> {
  const root = structuredClone(current);
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  cursor[segments.at(-1) as string] = value;
  return root;
}

function deletePath(
  current: Record<string, unknown>,
  segments: string[]
): Record<string, unknown> {
  const root = structuredClone(current);
  let cursor: Record<string, unknown> | undefined = root;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = cursor?.[segment];
    cursor =
      typeof next === "object" && next !== null
        ? (next as Record<string, unknown>)
        : undefined;
  }
  if (cursor) {
    delete cursor[segments.at(-1) as string];
  }
  return root;
}

function mask(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mask);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SECRET_KEY.test(key) ? "***" : mask(nested)
      ])
    );
  }
  return value;
}

function render(value: unknown): string {
  return JSON.stringify(mask(value), null, 2);
}
