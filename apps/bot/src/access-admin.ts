import type { BotKernel, StoreAccessPolicy } from "@umx-bot/core";
import type { BotPlugin, ConversationRef } from "@umx-bot/plugin-sdk";
import {
  defineArgs,
  definePlugin,
  PLUGIN_API_VERSION
} from "@umx-bot/plugin-sdk";

export interface AccessAdminOptions {
  bot: BotKernel;
  access: StoreAccessPolicy;
}

/**
 * `/acl`: per-chat plugin and command switches, plus a user blocklist.
 *
 * Switches apply to the conversation the command runs in, so a group admin can
 * turn a noisy plugin off for their group without touching anyone else. The
 * blocklist is per platform, so it is limited to bot owners (`BOT_OWNER_IDS`);
 * a group owner cannot block users or escape a block.
 */
export function createAccessAdminPlugin(
  options: AccessAdminOptions
): BotPlugin {
  const { bot, access } = options;
  const here = (message: ConversationRef): ConversationRef => ({
    platform: message.platform,
    scope: message.scope,
    conversationId: message.conversationId
  });

  return definePlugin({
    name: "access-admin",
    version: "0.5.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "按会话启停插件和命令，管理封禁名单",
    help: {
      title: "访问控制",
      description: "在当前聊天里开关插件或命令（仅管理员）",
      order: 99
    },
    setup(context) {
      const resolveTarget = (
        name: string
      ): { kind: "plugin" | "command"; name: string } | undefined => {
        if (bot.getHealth().plugins.some((plugin) => plugin.name === name)) {
          return { kind: "plugin", name };
        }
        const command = context.commands
          .list()
          .find(
            (candidate) =>
              candidate.name === name || candidate.aliases.includes(name)
          );
        return command ? { kind: "command", name: command.name } : undefined;
      };

      const toggle =
        (enabled: boolean) =>
        async (command: {
          message: ConversationRef;
          parsed: { name: string };
          reply(content: string): Promise<unknown>;
        }) => {
          const target = resolveTarget(command.parsed.name);
          if (!target) {
            await command.reply(`找不到插件或命令「${command.parsed.name}」。`);
            return;
          }
          try {
            if (target.kind === "plugin") {
              await access.setPluginEnabled(
                here(command.message),
                target.name,
                enabled
              );
            } else {
              const owner = context.commands
                .list()
                .find((candidate) => candidate.name === target.name)
                ?.plugin.name;
              if (!enabled && owner !== undefined && access.isExempt(owner)) {
                throw new Error(
                  `命令 ${target.name} 属于受保护的插件，不能停用`
                );
              }
              await access.setCommandEnabled(
                here(command.message),
                target.name,
                enabled
              );
            }
          } catch (error) {
            await command.reply(
              error instanceof Error ? error.message : String(error)
            );
            return;
          }
          await command.reply(
            `已在当前聊天${enabled ? "启用" : "停用"}${
              target.kind === "plugin" ? "插件" : "命令"
            } ${target.name}。`
          );
        };

      context.commands.register({
        name: "acl",
        description: "在当前聊天开关插件或命令",
        permission: "admin",
        subcommands: [
          {
            name: "status",
            description: "查看当前聊天停用了什么",
            args: defineArgs({}),
            async execute(command) {
              const state = await access.inspect(here(command.message));
              const lines = [
                state.disabledPlugins.length > 0
                  ? `已停用插件：${state.disabledPlugins.join("、")}`
                  : "没有停用的插件。",
                state.disabledCommands.length > 0
                  ? `已停用命令：${state.disabledCommands.join("、")}`
                  : "没有停用的命令。"
              ];
              await command.reply(lines.join("\n"));
            }
          },
          {
            name: "disable",
            description: "在当前聊天停用插件或命令",
            args: defineArgs({ name: { type: "string" } }),
            execute: (command) => toggle(false)(command as never)
          },
          {
            name: "enable",
            description: "在当前聊天重新启用插件或命令",
            args: defineArgs({ name: { type: "string" } }),
            execute: (command) => toggle(true)(command as never)
          },
          {
            name: "block",
            description: "封禁用户：其命令一律不响应（仅机器人主人）",
            permission: "owner",
            botOwnerOnly: true,
            args: defineArgs({ userId: { type: "string" } }),
            async execute(command) {
              const { userId } = command.parsed as { userId: string };
              await access.setBlocked(command.message.platform, userId, true);
              await command.reply(`已封禁 ${userId}。`);
            }
          },
          {
            name: "unblock",
            description: "解除封禁（仅机器人主人）",
            permission: "owner",
            botOwnerOnly: true,
            args: defineArgs({ userId: { type: "string" } }),
            async execute(command) {
              const { userId } = command.parsed as { userId: string };
              await access.setBlocked(command.message.platform, userId, false);
              await command.reply(`已解除封禁 ${userId}。`);
            }
          },
          {
            name: "blocked",
            description: "查看封禁名单（仅机器人主人）",
            permission: "owner",
            botOwnerOnly: true,
            async execute(command) {
              const list = await access.listBlocked(command.message.platform);
              await command.reply(
                list.length > 0
                  ? `封禁名单：${list.join("、")}`
                  : "封禁名单为空。"
              );
            }
          }
        ]
      });
    }
  });
}
