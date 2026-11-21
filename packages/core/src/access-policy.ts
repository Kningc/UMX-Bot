import type {
  Awaitable,
  ConversationRef,
  IncomingMessage,
  KeyValueStore,
  MemberRole
} from "@qq-bot/plugin-sdk";

export interface AccessRequest {
  message: IncomingMessage;
  plugin: string;
  command: string;
  subcommand?: string;
  requiredRole: MemberRole;
}

export type AccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Shown to the user. Omit to stay silent. */
      reason?: string;
    };

/**
 * Decides whether a command may run, on top of its static role requirement.
 * Replace it to plug in your own rules (an allowlist service, a billing
 * check, …); `StoreAccessPolicy` is the default.
 */
export interface AccessPolicy {
  check(request: AccessRequest): Awaitable<AccessDecision>;
}

interface ConversationRules {
  plugins: string[];
  commands: string[];
}

export interface AccessInspection {
  disabledPlugins: string[];
  disabledCommands: string[];
}

export interface StoreAccessPolicyOptions {
  /**
   * Plugins that can never be disabled, so an admin cannot lock themselves
   * out of the very commands that re-enable things.
   */
  exemptPlugins?: Iterable<string>;
}

/**
 * Per-conversation plugin/command switches and a per-platform user blocklist,
 * persisted in the bot's key-value store.
 *
 * Owners bypass the blocklist, so a misfired `block` can always be undone.
 */
export class StoreAccessPolicy implements AccessPolicy {
  private readonly exempt: ReadonlySet<string>;

  public constructor(
    private readonly store: KeyValueStore,
    options: StoreAccessPolicyOptions = {}
  ) {
    this.exempt = new Set(options.exemptPlugins ?? []);
  }

  public isExempt(plugin: string): boolean {
    return this.exempt.has(plugin);
  }

  public async check(request: AccessRequest): Promise<AccessDecision> {
    if (this.exempt.has(request.plugin)) {
      return { allowed: true };
    }
    const { message } = request;
    if (
      message.author.role !== "owner" &&
      (await this.isBlocked(message.platform, message.author.id))
    ) {
      return { allowed: false };
    }
    const rules = await this.store.get<ConversationRules>(
      conversationKey(message)
    );
    if (!rules) {
      return { allowed: true };
    }
    if (rules.plugins.includes(request.plugin)) {
      return { allowed: false };
    }
    if (rules.commands.includes(request.command)) {
      return { allowed: false };
    }
    return { allowed: true };
  }

  public async inspect(target: ConversationRef): Promise<AccessInspection> {
    const rules = await this.store.get<ConversationRules>(
      conversationKey(target)
    );
    return {
      disabledPlugins: [...(rules?.plugins ?? [])].sort(),
      disabledCommands: [...(rules?.commands ?? [])].sort()
    };
  }

  public async setPluginEnabled(
    target: ConversationRef,
    plugin: string,
    enabled: boolean
  ): Promise<void> {
    if (!enabled && this.exempt.has(plugin)) {
      throw new Error(`plugin "${plugin}" cannot be disabled`);
    }
    await this.updateRules(target, (rules) => ({
      ...rules,
      plugins: toggle(rules.plugins, plugin, !enabled)
    }));
  }

  public async setCommandEnabled(
    target: ConversationRef,
    command: string,
    enabled: boolean
  ): Promise<void> {
    await this.updateRules(target, (rules) => ({
      ...rules,
      commands: toggle(rules.commands, command, !enabled)
    }));
  }

  public async isBlocked(platform: string, userId: string): Promise<boolean> {
    const blocked = await this.store.get<string[]>(blockKey(platform));
    return blocked?.includes(userId) ?? false;
  }

  public async setBlocked(
    platform: string,
    userId: string,
    blocked: boolean
  ): Promise<void> {
    await this.store.update<string[]>(blockKey(platform), (current) => {
      const next = toggle(current ?? [], userId, blocked);
      return next.length === 0 ? undefined : next;
    });
  }

  public async listBlocked(platform: string): Promise<string[]> {
    return [...((await this.store.get<string[]>(blockKey(platform))) ?? [])];
  }

  private async updateRules(
    target: ConversationRef,
    change: (rules: ConversationRules) => ConversationRules
  ): Promise<void> {
    await this.store.update<ConversationRules>(
      conversationKey(target),
      (current) => {
        const next = change(current ?? { plugins: [], commands: [] });
        return next.plugins.length === 0 && next.commands.length === 0
          ? undefined
          : next;
      }
    );
  }
}

function toggle(list: string[], value: string, present: boolean): string[] {
  const without = list.filter((item) => item !== value);
  return present ? [...without, value].sort() : without;
}

function conversationKey(target: ConversationRef): string {
  return [
    "access",
    "conversation",
    encodeURIComponent(target.platform),
    encodeURIComponent(target.scope),
    encodeURIComponent(target.conversationId)
  ].join(":");
}

function blockKey(platform: string): string {
  return `access:blocked:${encodeURIComponent(platform)}`;
}
