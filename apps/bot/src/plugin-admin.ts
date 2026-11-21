import type { BotKernel } from "@qq-bot/core";
import type { BotPlugin } from "@qq-bot/plugin-sdk";
import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";
import type { PluginManager, PluginStatus } from "./plugin-loader.js";

export interface PluginAdminOptions {
  bot: BotKernel;
  manager: PluginManager;
}

/**
 * Owner-only runtime control over the plugin set.
 *
 * It lives in the application rather than in `plugins/` because it needs the
 * manifest, which is a deployment concern the kernel deliberately knows
 * nothing about. Changes are in-process only: the manifest stays the source of
 * truth, so a restart goes back to whatever it says.
 */
export function createPluginAdminPlugin(
  options: PluginAdminOptions
): BotPlugin {
  const { bot, manager } = options;

  return definePlugin({
    name: "plugin-admin",
    version: "0.5.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "运行时查看和切换插件",
    help: {
      title: "插件管理",
      description: "查看、停用、启用和重载插件（仅机器人 owner）",
      order: 100
    },
    setup(context) {
      context.commands.register({
        name: "plugin",
        description: "管理运行中的插件",
        permission: "owner",
        examples: [
          { args: "list", description: "列出插件及其状态" },
          { args: "disable <名称>", description: "立即停用一个插件" },
          { args: "enable <名称>", description: "按清单启用一个插件" },
          { args: "reload <名称>", description: "重新加载一个插件" }
        ],
        async execute(command) {
          const [action, target] = command.args;
          if (
            target === "plugin-admin" &&
            (action === "disable" || action === "reload")
          ) {
            // Unloading it would remove this very command, and the manifest
            // has no entry that could bring it back at runtime.
            await command.reply(
              "不能在运行时停用或重载 plugin-admin 自己，否则只能重启才能恢复。"
            );
            return;
          }
          try {
            switch (action) {
              case undefined:
              case "list":
                await command.reply(renderList(await manager.list(bot)));
                return;
              case "disable": {
                if (!target) {
                  await command.reply("用法：plugin disable <名称>");
                  return;
                }
                const unloaded = await manager.disable(bot, target);
                await command.reply(
                  unloaded
                    ? `已停用 ${target}。重启后会按清单恢复。`
                    : `${target} 当前没有加载。`
                );
                return;
              }
              case "enable": {
                if (!target) {
                  await command.reply("用法：plugin enable <名称>");
                  return;
                }
                const loaded = await manager.enable(bot, target);
                await command.reply(
                  loaded
                    ? `已启用 ${target}。注意它不会收到 bot.ready。`
                    : `${target} 已经在运行。`
                );
                return;
              }
              case "reload": {
                if (!target) {
                  await command.reply("用法：plugin reload <名称>");
                  return;
                }
                const picksUpCode = manager.reloadPicksUpCode(target);
                await manager.reload(bot, target);
                await command.reply(
                  picksUpCode
                    ? `已重载 ${target}，配置与代码都已生效。`
                    : `已重载 ${target}。它是 npm 包，Node 会复用已缓存的模块：` +
                        "配置生效，代码改动需要重启。"
                );
                return;
              }
              default:
                await command.reply(
                  "未知子命令。可用：list、disable、enable、reload。"
                );
            }
          } catch (error) {
            // The operator needs the actual reason — a dependency still
            // needing the plugin, a missing manifest entry, a bad import.
            await command.reply(
              `操作失败：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      });

      context.navigation.register({
        items: [
          {
            id: "plugin-list",
            label: "插件状态",
            command: "plugin",
            args: "list",
            description: "查看插件加载状态",
            scopes: ["direct"],
            surfaces: ["message"],
            permission: "owner"
          }
        ]
      });
    }
  });
}

function renderList(statuses: PluginStatus[]): string {
  if (statuses.length === 0) {
    return "没有任何插件。";
  }
  const lines = statuses.map((status) => {
    const state = status.loaded
      ? "运行中"
      : status.configured
        ? "清单已启用但未加载"
        : "已停用";
    const version = status.version ? ` v${status.version}` : "";
    return `• ${status.name}${version} — ${state}`;
  });
  return [`插件 ${statuses.length} 个：`, ...lines].join("\n");
}
