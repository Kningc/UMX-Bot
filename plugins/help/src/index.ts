import {
  type CommandSummary,
  definePlugin,
  helpService,
  type IncomingMessage,
  type MessageContent,
  type NavigationPageSummary,
  PLUGIN_API_VERSION
} from "@umx-bot/plugin-sdk";
import { buildCatalog } from "./catalog.js";
import { renderView } from "./render.js";
import { resolveHelp } from "./resolve.js";

export type { HelpCatalog, HelpSection } from "./catalog.js";
export { buildCatalog } from "./catalog.js";
export type { HelpRenderOptions } from "./render.js";
export { renderView } from "./render.js";
export type { HelpSuggestion, HelpView } from "./resolve.js";
export { resolveHelp } from "./resolve.js";

export interface HelpPluginConfig {
  /** Heading of the main navigation. Defaults to "功能导航". */
  title: string;
}

const DEFAULT_TITLE = "功能导航";
const MAX_TITLE_LENGTH = 30;

export function parseHelpConfig(value: unknown): HelpPluginConfig {
  const input = (value ?? {}) as { title?: unknown };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("help config must be an object");
  }
  if (input.title === undefined) {
    return { title: DEFAULT_TITLE };
  }
  if (
    typeof input.title !== "string" ||
    input.title.trim().length === 0 ||
    input.title.trim().length > MAX_TITLE_LENGTH
  ) {
    throw new Error(
      `help config "title" must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`
    );
  }
  return { title: input.title.trim() };
}

export interface HelpRenderInput {
  /** Pages already filtered for the reader (`navigation.available`). */
  pages: readonly NavigationPageSummary[];
  /** Commands already filtered for the reader (`commands.available`). */
  commands: readonly CommandSummary[];
  /** The help command with its prefix, such as `/help`. */
  helpCommand: string;
  /** The configured command prefix, such as `/`. */
  prefix: string;
  title?: string;
  query?: string;
}

/** Builds, resolves and renders in one go. */
export function renderHelp({
  pages,
  commands,
  helpCommand,
  prefix,
  title = DEFAULT_TITLE,
  query
}: HelpRenderInput): MessageContent {
  const catalog = buildCatalog(pages, commands);
  return renderView(resolveHelp(catalog, query, prefix), catalog, {
    helpCommand,
    title
  });
}

export function isMentionOnly(content: string): boolean {
  const withoutMarkup = content
    .replace(/<@!?[^>\s]+>/gu, "")
    .replace(/​/gu, "")
    .trim();
  return withoutMarkup.length === 0 || /^@\S+$/u.test(withoutMarkup);
}

export default definePlugin({
  name: "help",
  version: "0.6.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "显示可点击的插件导航与命令帮助",
  help: {
    listed: false
  },
  configuration: { parse: parseHelpConfig },
  setup(context) {
    const helpCommand = context.commands.format("help");
    const prefix = context.commands.format("");

    const render = async (
      message: IncomingMessage,
      query?: string
    ): Promise<MessageContent> => {
      const [pages, commands] = await Promise.all([
        context.navigation.available(message),
        context.commands.available(message)
      ]);
      return renderHelp({
        pages,
        commands,
        helpCommand,
        prefix,
        title: context.config.title,
        ...(query ? { query } : {})
      });
    };

    context.services.provide(helpService, { render });

    context.navigation.register({
      order: -100,
      items: [
        {
          id: "help",
          label: "帮助",
          command: "help",
          description: "查看全部功能",
          scopes: ["direct", "group"],
          surfaces: ["menu", "panel"]
        }
      ]
    });

    context.middleware.use(
      async (message, next) => {
        if (
          message.message.scope === "group" &&
          message.message.botMentioned &&
          message.message.attachments.length === 0 &&
          isMentionOnly(message.message.content)
        ) {
          message.handled = true;
          await message.reply(await render(message.message));
          return;
        }
        await next();
      },
      { priority: 1_000 }
    );

    context.commands.register({
      name: "help",
      description: "显示可点击的插件导航与命令帮助",
      aliases: ["帮助"],
      usage: "[插件|命令 [子命令]|页码]",
      examples: [
        { description: "打开主导航" },
        { args: "mc", description: "查看某个插件或命令的完整帮助" },
        { args: "acl disable", description: "查看子命令的用法" },
        { args: "2", description: "主导航按钮的第 2 页" }
      ],
      async execute(command) {
        await command.reply(await render(command.message, command.rawArgs));
      }
    });
  }
});
