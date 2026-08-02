import type {
  CommandContext,
  CommandDefinition,
  CommandSummary,
  Dispose,
  IncomingMessage,
  Logger,
  MemberRole,
  MessageSender,
  PluginHelpSummary
} from "@qq-bot/plugin-sdk";
import { CommandParseError, parseCommand } from "./command-parser.js";

interface RegisteredCommand {
  definition: CommandDefinition;
  plugin: PluginHelpSummary;
}

const roleWeight: Record<MemberRole, number> = {
  member: 0,
  admin: 1,
  owner: 2
};

export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly cooldowns = new Map<string, number>();

  public constructor(
    private readonly prefix: string,
    private readonly messages: MessageSender,
    private readonly logger: Logger
  ) {
    if (prefix.length === 0) {
      throw new Error("command prefix cannot be empty");
    }
  }

  public forPlugin(plugin: PluginHelpSummary): {
    register(command: CommandDefinition): Dispose;
    list(): CommandSummary[];
    format(name: string, args?: string): string;
  } {
    return {
      register: (command) => this.register(plugin, command),
      list: () => this.list(),
      format: (name, args) => this.format(name, args)
    };
  }

  public format(name: string, args?: string): string {
    return `${this.prefix}${name}${args ? ` ${args}` : ""}`;
  }

  public list(): CommandSummary[] {
    const unique = new Map<string, CommandSummary>();

    for (const { definition, plugin } of this.commands.values()) {
      if (unique.has(definition.name)) {
        continue;
      }

      unique.set(definition.name, {
        name: definition.name,
        invocation: this.format(definition.name),
        description: definition.description,
        aliases: definition.aliases ?? [],
        aliasInvocations: (definition.aliases ?? []).map((alias) =>
          this.format(alias)
        ),
        permission: definition.permission ?? "member",
        plugin: { ...plugin },
        usage: this.format(definition.name, definition.usage),
        examples: (definition.examples ?? []).map((example) => ({
          command: this.format(definition.name, example.args),
          ...(example.description
            ? { description: example.description }
            : {})
        })),
        hidden: definition.hidden ?? false
      });
    }

    return [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN")
    );
  }

  public async handle(message: IncomingMessage): Promise<boolean> {
    const content = commandContent(message);
    if (!content.startsWith(this.prefix)) {
      return false;
    }

    const input = content.slice(this.prefix.length);
    let parsed;
    try {
      parsed = parseCommand(input);
    } catch (error) {
      if (error instanceof CommandParseError) {
        await this.messages.reply(message, `命令参数格式错误：${error.message}`);
        return true;
      }
      throw error;
    }
    if (!parsed) {
      return false;
    }

    const registered = this.commands.get(parsed.name.toLowerCase());
    if (!registered) {
      return false;
    }

    const requiredRole = registered.definition.permission ?? "member";
    if (roleWeight[message.author.role] < roleWeight[requiredRole]) {
      await this.messages.reply(message, "权限不足，无法执行该命令。");
      return true;
    }

    const cooldownMs = registered.definition.cooldownMs ?? 0;
    if (cooldownMs > 0) {
      const cooldownKey = [
        registered.definition.name,
        message.conversationId,
        message.author.id
      ].join(":");
      const now = Date.now();
      const availableAt = this.cooldowns.get(cooldownKey) ?? 0;
      if (availableAt > now) {
        const seconds = Math.max(1, Math.ceil((availableAt - now) / 1_000));
        await this.messages.reply(
          message,
          `命令冷却中，请在 ${seconds} 秒后再试。`
        );
        return true;
      }
      this.cooldowns.set(cooldownKey, now + cooldownMs);
      this.pruneCooldowns(now);
    }

    const context: CommandContext = {
      message,
      command: registered.definition.name,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      reply: (contentToSend) => this.messages.reply(message, contentToSend)
    };

    try {
      await registered.definition.execute(context);
    } catch (error) {
      this.logger.error(
        {
          error,
          command: registered.definition.name,
          plugin: registered.plugin.name
        },
        "command failed"
      );
      await this.messages.reply(message, "命令执行失败，请稍后再试。");
    }

    return true;
  }

  private register(
    plugin: PluginHelpSummary,
    definition: CommandDefinition
  ): Dispose {
    this.validateDefinition(definition);
    const names = [definition.name, ...(definition.aliases ?? [])].map((name) =>
      name.trim().toLowerCase()
    );

    for (const name of names) {
      if (this.commands.has(name)) {
        throw new Error(`command "${name}" is already registered`);
      }
    }

    const registered = { definition, plugin };
    for (const name of names) {
      this.commands.set(name, registered);
    }

    return () => {
      for (const name of names) {
        if (this.commands.get(name) === registered) {
          this.commands.delete(name);
        }
      }
    };
  }

  private validateDefinition(definition: CommandDefinition): void {
    const names = [definition.name, ...(definition.aliases ?? [])];
    if (definition.description.trim().length === 0) {
      throw new Error("command description cannot be empty");
    }
    if (
      definition.usage !== undefined &&
      (definition.usage.trim() !== definition.usage ||
        definition.usage.length === 0)
    ) {
      throw new Error(
        `command "${definition.name}" usage cannot be empty or contain surrounding whitespace`
      );
    }
    for (const example of definition.examples ?? []) {
      if (
        example.args !== undefined &&
        (example.args.trim() !== example.args || example.args.length === 0)
      ) {
        throw new Error(
          `command "${definition.name}" example arguments cannot be empty or contain surrounding whitespace`
        );
      }
      if (
        example.description !== undefined &&
        example.description.trim().length === 0
      ) {
        throw new Error(
          `command "${definition.name}" example description cannot be empty`
        );
      }
    }
    for (const name of names) {
      if (name.trim() !== name || name.length === 0 || /[\s/]/u.test(name)) {
        throw new Error(`invalid command name or alias "${name}"`);
      }
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      throw new Error(`command "${definition.name}" contains duplicate aliases`);
    }
    if (
      definition.cooldownMs !== undefined &&
      (!Number.isSafeInteger(definition.cooldownMs) ||
        definition.cooldownMs < 0)
    ) {
      throw new Error("command cooldown must be a non-negative integer");
    }
  }

  private pruneCooldowns(now: number): void {
    if (this.cooldowns.size < 1_000) {
      return;
    }
    for (const [key, availableAt] of this.cooldowns) {
      if (availableAt <= now) {
        this.cooldowns.delete(key);
      }
    }
  }
}

function commandContent(message: IncomingMessage): string {
  const normalized = message.content.trim();
  if (!message.botMentioned) {
    return normalized;
  }

  const mentionNormalized = normalized.replace(/\u200b/gu, "").trim();
  const withoutMarkup = mentionNormalized
    .replace(/^(?:<@!?[^>\s]+>\s*)+/u, "")
    .trim();
  if (withoutMarkup !== mentionNormalized) {
    return withoutMarkup;
  }

  return mentionNormalized.replace(/^@\S+(?:\s+|$)/u, "").trim();
}
