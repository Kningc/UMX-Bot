import type {
  CommandContext,
  CommandDefinition,
  CommandSummary,
  Dispose,
  IncomingMessage,
  Logger,
  MemberRole,
  MessageSender
} from "@qq-bot/plugin-sdk";

interface RegisteredCommand {
  definition: CommandDefinition;
  plugin: string;
}

const roleWeight: Record<MemberRole, number> = {
  member: 0,
  admin: 1,
  owner: 2
};

export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();

  public constructor(
    private readonly prefix: string,
    private readonly messages: MessageSender,
    private readonly logger: Logger
  ) {
    if (prefix.length === 0) {
      throw new Error("command prefix cannot be empty");
    }
  }

  public forPlugin(plugin: string): {
    register(command: CommandDefinition): Dispose;
    list(): CommandSummary[];
  } {
    return {
      register: (command) => this.register(plugin, command),
      list: () => this.list()
    };
  }

  public list(): CommandSummary[] {
    const unique = new Map<string, CommandSummary>();

    for (const { definition, plugin } of this.commands.values()) {
      if (unique.has(definition.name)) {
        continue;
      }

      unique.set(definition.name, {
        name: definition.name,
        description: definition.description,
        aliases: definition.aliases ?? [],
        permission: definition.permission ?? "member",
        plugin
      });
    }

    return [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN")
    );
  }

  public async handle(message: IncomingMessage): Promise<boolean> {
    const content = message.content.trim();
    if (!content.startsWith(this.prefix)) {
      return false;
    }

    const input = content.slice(this.prefix.length).trim();
    if (input.length === 0) {
      return false;
    }

    const [commandName = "", ...args] = input.split(/\s+/u);
    const registered = this.commands.get(commandName.toLowerCase());
    if (!registered) {
      return false;
    }

    const requiredRole = registered.definition.permission ?? "member";
    if (roleWeight[message.author.role] < roleWeight[requiredRole]) {
      await this.messages.reply(message, "权限不足，无法执行该命令。");
      return true;
    }

    const rawArgs = input.slice(commandName.length).trim();
    const context: CommandContext = {
      message,
      command: registered.definition.name,
      args,
      rawArgs,
      reply: (contentToSend) => this.messages.reply(message, contentToSend)
    };

    try {
      await registered.definition.execute(context);
    } catch (error) {
      this.logger.error(
        {
          error,
          command: registered.definition.name,
          plugin: registered.plugin
        },
        "command failed"
      );
      await this.messages.reply(message, "命令执行失败，请稍后再试。");
    }

    return true;
  }

  private register(plugin: string, definition: CommandDefinition): Dispose {
    const names = [definition.name, ...(definition.aliases ?? [])].map((name) =>
      name.toLowerCase()
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
}
