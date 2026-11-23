import type {
  CommandContext,
  CommandDefinition,
  CommandExecutedEvent,
  CommandSummary,
  Dispose,
  IncomingMessage,
  Logger,
  MemberRole,
  MessageContent,
  MessageSender,
  PluginHelpSummary,
  SubcommandDefinition,
  SubcommandSummary
} from "@umx-bot/plugin-sdk";
import { CommandArgumentError } from "@umx-bot/plugin-sdk";
import type { AccessPolicy } from "./access-policy.js";
import type { ParsedCommand } from "./command-parser.js";
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

export interface CommandRouterHooks {
  /** Extra gate evaluated after the role check. */
  access?: AccessPolicy;
  /** Called once per command attempt that reached a registered command. */
  onExecuted?: (event: CommandExecutedEvent) => void | Promise<void>;
  /**
   * Answers a command that has only subcommands when none matched. Return
   * undefined to fall back to the built-in subcommand list.
   */
  subcommandHelp?: (
    message: IncomingMessage,
    command: string
  ) => Promise<MessageContent | undefined>;
}

/** What actually runs: the command itself or one of its subcommands. */
interface Target {
  subcommand: SubcommandDefinition | undefined;
  permission: MemberRole;
  botOwnerOnly: boolean;
  cooldownMs: number;
  scopes: readonly string[] | undefined;
  args: CommandDefinition["args"];
  usage: string | undefined;
  execute: NonNullable<CommandDefinition["execute"]>;
}

export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly cooldowns = new Map<string, number>();

  public constructor(
    private readonly prefix: string,
    private readonly messages: MessageSender,
    private readonly logger: Logger,
    private readonly hooks: CommandRouterHooks = {}
  ) {
    if (prefix.length === 0) {
      throw new Error("command prefix cannot be empty");
    }
  }

  public forPlugin(plugin: PluginHelpSummary): {
    register(command: CommandDefinition): Dispose;
    list(): CommandSummary[];
    available(message: IncomingMessage): Promise<CommandSummary[]>;
    format(name: string, args?: string): string;
  } {
    return {
      register: (command) => this.register(plugin, command),
      list: () => this.list(),
      available: (message) => this.available(message),
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
        ...(definition.botOwnerOnly ? { botOwnerOnly: true as const } : {}),
        plugin: { ...plugin },
        usage: this.format(
          definition.name,
          definition.usage ?? definition.args?.usage
        ),
        examples: (definition.examples ?? []).map((example) => ({
          command: this.format(definition.name, example.args),
          ...(example.description ? { description: example.description } : {})
        })),
        hidden: definition.hidden ?? false,
        ...(definition.panel !== undefined ? { panel: definition.panel } : {}),
        ...(definition.scopes ? { scopes: [...definition.scopes] } : {}),
        ...(definition.subcommands && definition.subcommands.length > 0
          ? {
              subcommands: definition.subcommands.map((sub) =>
                this.summarizeSubcommand(definition, sub)
              )
            }
          : {})
      });
    }

    return [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN")
    );
  }

  /**
   * What the message's author can run in its chat: leaves out hidden
   * commands and subcommands, those scoped to other chats, those above the
   * author's role and commands the access policy blocks here.
   */
  public async available(message: IncomingMessage): Promise<CommandSummary[]> {
    const definitions = new Map<string, RegisteredCommand>();
    for (const registered of this.commands.values()) {
      definitions.set(registered.definition.name, registered);
    }
    const result: CommandSummary[] = [];
    for (const summary of this.list()) {
      const registered = definitions.get(summary.name);
      if (!registered || summary.hidden) {
        continue;
      }
      const { definition } = registered;
      const reachable = (
        permission: MemberRole,
        scopes: readonly string[] | undefined,
        botOwnerOnly: boolean | undefined
      ) =>
        (botOwnerOnly !== true || message.author.botOwner === true) &&
        roleWeight[message.author.role] >= roleWeight[permission] &&
        (scopes === undefined || scopes.includes(message.scope));
      const subcommands = (definition.subcommands ?? []).filter(
        (sub) =>
          !(sub.hidden ?? false) &&
          reachable(
            sub.permission ?? definition.permission ?? "member",
            sub.scopes ?? definition.scopes,
            sub.botOwnerOnly ?? definition.botOwnerOnly
          )
      );
      const ownReachable =
        definition.execute !== undefined &&
        reachable(
          summary.permission,
          definition.scopes,
          definition.botOwnerOnly
        );
      if (!ownReachable && subcommands.length === 0) {
        continue;
      }
      if (this.hooks.access) {
        const decision = await this.hooks.access.check({
          message,
          plugin: registered.plugin.name,
          command: summary.name,
          requiredRole: summary.permission
        });
        if (!decision.allowed) {
          continue;
        }
      }
      const visibleNames = new Set(subcommands.map((sub) => sub.name));
      const { subcommands: allSubcommands, ...rest } = summary;
      const kept = (allSubcommands ?? []).filter((sub) =>
        visibleNames.has(sub.name)
      );
      result.push({
        ...rest,
        ...(kept.length > 0 ? { subcommands: kept } : {})
      });
    }
    return result;
  }

  private summarizeSubcommand(
    parent: CommandDefinition,
    sub: SubcommandDefinition
  ): SubcommandSummary {
    const path = `${parent.name} ${sub.name}`;
    return {
      name: sub.name,
      invocation: this.format(path),
      description: sub.description,
      aliases: sub.aliases ?? [],
      permission: sub.permission ?? parent.permission ?? "member",
      ...((sub.botOwnerOnly ?? parent.botOwnerOnly)
        ? { botOwnerOnly: true as const }
        : {}),
      usage: this.format(path, sub.usage ?? sub.args?.usage),
      examples: (sub.examples ?? []).map((example) => ({
        command: this.format(path, example.args),
        ...(example.description ? { description: example.description } : {})
      })),
      hidden: sub.hidden ?? parent.hidden ?? false
    };
  }

  public async handle(message: IncomingMessage): Promise<boolean> {
    const content = commandContent(message);
    if (!content.startsWith(this.prefix)) {
      return false;
    }

    const input = content.slice(this.prefix.length);
    let parsed: ParsedCommand | undefined;
    try {
      parsed = parseCommand(input);
    } catch (error) {
      if (error instanceof CommandParseError) {
        await this.messages.reply(
          message,
          `命令参数格式错误：${error.message}`
        );
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

    const target = this.resolveTarget(registered.definition, parsed);
    if (!target) {
      // Only subcommands, none matched: tell the user what exists.
      let help: MessageContent | undefined;
      try {
        help = await this.hooks.subcommandHelp?.(
          message,
          registered.definition.name
        );
      } catch (error) {
        this.logger.error({ error }, "subcommand help hook failed");
      }
      await this.messages.reply(
        message,
        help ?? this.subcommandHelp(registered.definition, message)
      );
      return true;
    }
    if (target.scopes && !target.scopes.includes(message.scope)) {
      // Behaves as if the command did not exist in this chat.
      return false;
    }

    const startedAt = performance.now();
    const name = registered.definition.name;
    const subcommandName = target.subcommand?.name;
    const finish = async (
      outcome: CommandExecutedEvent["outcome"],
      reason?: CommandExecutedEvent["reason"]
    ): Promise<void> => {
      try {
        await this.hooks.onExecuted?.({
          command: name,
          ...(subcommandName ? { subcommand: subcommandName } : {}),
          plugin: registered.plugin.name,
          outcome,
          ...(reason ? { reason } : {}),
          durationMs: performance.now() - startedAt,
          message
        });
      } catch (error) {
        this.logger.error({ error }, "command execution hook failed");
      }
    };
    const auditExtra = subcommandName ? { subcommand: subcommandName } : {};

    const requiredRole = target.permission;
    const lacksBotOwner =
      target.botOwnerOnly && message.author.botOwner !== true;
    if (
      roleWeight[message.author.role] < roleWeight[requiredRole] ||
      lacksBotOwner
    ) {
      this.audit("denied", message, registered, {
        requiredRole,
        ...(target.botOwnerOnly ? { requiredBotOwner: true } : {}),
        ...auditExtra
      });
      await this.messages.reply(message, "权限不足，无法执行该命令。");
      await finish("denied");
      return true;
    }

    if (this.hooks.access) {
      const decision = await this.hooks.access.check({
        message,
        plugin: registered.plugin.name,
        command: name,
        ...(subcommandName ? { subcommand: subcommandName } : {}),
        requiredRole
      });
      if (!decision.allowed) {
        this.audit("denied", message, registered, {
          cause: "access",
          ...auditExtra
        });
        if (decision.reason) {
          await this.messages.reply(message, decision.reason);
        }
        await finish("rejected", "access");
        return true;
      }
    }

    let typed: unknown;
    if (target.args) {
      try {
        typed = target.args.parse({
          args: parsed.args,
          rawArgs: parsed.rawArgs
        });
      } catch (error) {
        const detail =
          error instanceof CommandArgumentError ? error.message : "参数不合法";
        const usage = this.format(
          subcommandName ? `${name} ${subcommandName}` : name,
          target.usage ?? target.args.usage
        );
        await this.messages.reply(message, `${detail}\n用法：${usage}`);
        await finish("rejected", "arguments");
        return true;
      }
    }

    // Only a well-formed invocation starts the cooldown: a typo in the
    // arguments should not lock the user out for the whole period.
    if (target.cooldownMs > 0) {
      const cooldownKey = [
        name,
        subcommandName ?? "",
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
        await finish("rejected", "cooldown");
        return true;
      }
      this.cooldowns.set(cooldownKey, now + target.cooldownMs);
      this.pruneCooldowns(now);
    }

    const context: CommandContext = {
      message,
      command: name,
      ...(subcommandName ? { subcommand: subcommandName } : {}),
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      parsed: typed,
      logger: this.logger.child({
        plugin: registered.plugin.name,
        command: name,
        ...(subcommandName ? { subcommand: subcommandName } : {}),
        messageId: message.id
      }),
      reply: (contentToSend) => this.messages.reply(message, contentToSend)
    };

    this.audit("accepted", message, registered, {
      argumentCount: parsed.args.length,
      ...auditExtra
    });
    let outcome: CommandExecutedEvent["outcome"] = "completed";
    try {
      await target.execute(context);
    } catch (error) {
      outcome = "failed";
      this.audit("failed", message, registered, auditExtra);
      this.logger.error(
        {
          error,
          command: name,
          plugin: registered.plugin.name
        },
        "command failed"
      );
      await this.messages.reply(message, "命令执行失败，请稍后再试。");
    }

    await finish(outcome);
    return true;
  }

  /**
   * Picks the subcommand named by the first argument, falling back to the
   * command's own `execute`. Returns undefined only for a command that has
   * subcommands but no `execute`, when nothing matched.
   */
  private resolveTarget(
    definition: CommandDefinition,
    parsed: ParsedCommand
  ): Target | undefined {
    const first = parsed.args[0]?.toLowerCase();
    const sub =
      first === undefined
        ? undefined
        : definition.subcommands?.find((candidate) =>
            [candidate.name, ...(candidate.aliases ?? [])].some(
              (alias) => alias.toLowerCase() === first
            )
          );
    if (sub) {
      const consumed = parsed.args[0] ?? "";
      parsed.args = parsed.args.slice(1);
      parsed.rawArgs = parsed.rawArgs.startsWith(consumed)
        ? parsed.rawArgs.slice(consumed.length).trim()
        : parsed.args.join(" ");
      return {
        subcommand: sub,
        permission: sub.permission ?? definition.permission ?? "member",
        botOwnerOnly: sub.botOwnerOnly ?? definition.botOwnerOnly ?? false,
        cooldownMs: sub.cooldownMs ?? definition.cooldownMs ?? 0,
        scopes: sub.scopes ?? definition.scopes,
        args: sub.args,
        usage: sub.usage,
        execute: (context) => sub.execute(context)
      };
    }
    if (!definition.execute) {
      return undefined;
    }
    const execute = definition.execute.bind(definition);
    return {
      subcommand: undefined,
      permission: definition.permission ?? "member",
      botOwnerOnly: definition.botOwnerOnly ?? false,
      cooldownMs: definition.cooldownMs ?? 0,
      scopes: definition.scopes,
      args: definition.args,
      usage: definition.usage,
      execute
    };
  }

  private subcommandHelp(
    definition: CommandDefinition,
    message: IncomingMessage
  ): string {
    const lines = (definition.subcommands ?? [])
      .filter((sub) => {
        const permission = sub.permission ?? definition.permission ?? "member";
        const scopes = sub.scopes ?? definition.scopes;
        const botOwnerOnly = sub.botOwnerOnly ?? definition.botOwnerOnly;
        return (
          !(sub.hidden ?? definition.hidden ?? false) &&
          (botOwnerOnly !== true || message.author.botOwner === true) &&
          roleWeight[message.author.role] >= roleWeight[permission] &&
          (scopes === undefined || scopes.includes(message.scope))
        );
      })
      .map((sub) => {
        const summary = this.summarizeSubcommand(definition, sub);
        return `• ${summary.usage} — ${summary.description}`;
      });
    if (lines.length === 0) {
      return `${this.format(definition.name)} 没有你在这里可用的子命令。`;
    }
    return [`${this.format(definition.name)} 可用的子命令：`, ...lines].join(
      "\n"
    );
  }

  /**
   * Records who ran what, where.
   *
   * Deliberately omits the message text and the parsed arguments: a command
   * can carry an address, an API key or private content, and the audit trail
   * must stay safe to keep and to share. The message id is enough to correlate
   * with the platform when a real investigation is needed.
   */
  private audit(
    outcome: "accepted" | "denied" | "failed",
    message: IncomingMessage,
    registered: RegisteredCommand,
    extra: Record<string, unknown>
  ): void {
    this.logger.info(
      {
        audit: "command",
        outcome,
        command: registered.definition.name,
        plugin: registered.plugin.name,
        platform: message.platform,
        scope: message.scope,
        conversationId: message.conversationId,
        authorId: message.author.id,
        role: message.author.role,
        ...(message.author.botOwner ? { botOwner: true } : {}),
        messageId: message.id,
        ...extra
      },
      `command ${outcome}`
    );
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
    if (
      definition.execute === undefined &&
      (definition.subcommands?.length ?? 0) === 0
    ) {
      throw new Error(
        `command "${definition.name}" needs an execute function or subcommands`
      );
    }
    const subNames = new Set<string>();
    for (const sub of definition.subcommands ?? []) {
      for (const alias of [sub.name, ...(sub.aliases ?? [])]) {
        if (
          alias.trim() !== alias ||
          alias.length === 0 ||
          /[\s/]/u.test(alias)
        ) {
          throw new Error(
            `invalid subcommand name or alias "${alias}" on "${definition.name}"`
          );
        }
        if (subNames.has(alias.toLowerCase())) {
          throw new Error(
            `command "${definition.name}" has a duplicate subcommand "${alias}"`
          );
        }
        subNames.add(alias.toLowerCase());
      }
      if (sub.description.trim().length === 0) {
        throw new Error(
          `subcommand "${sub.name}" of "${definition.name}" needs a description`
        );
      }
      if (
        sub.cooldownMs !== undefined &&
        (!Number.isSafeInteger(sub.cooldownMs) || sub.cooldownMs < 0)
      ) {
        throw new Error("command cooldown must be a non-negative integer");
      }
    }
    if (definition.description.trim().length === 0) {
      throw new Error("command description cannot be empty");
    }
    if (
      definition.panel !== undefined &&
      typeof definition.panel !== "boolean"
    ) {
      throw new Error(`command "${definition.name}" panel must be a boolean`);
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
    if (
      new Set(names.map((name) => name.toLowerCase())).size !== names.length
    ) {
      throw new Error(
        `command "${definition.name}" contains duplicate aliases`
      );
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
