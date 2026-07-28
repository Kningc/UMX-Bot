export type Awaitable<T> = T | Promise<T>;
export type Dispose = () => Awaitable<void>;

export type ChatScope = "group" | "direct" | "guild";
export type MemberRole = "member" | "admin" | "owner";

export interface MessageAuthor {
  id: string;
  name?: string;
  role: MemberRole;
}

export interface IncomingMessage {
  id: string;
  platform: string;
  scope: ChatScope;
  conversationId: string;
  author: MessageAuthor;
  content: string;
  timestamp: Date;
  raw?: unknown;
}

export interface OutgoingMessage {
  conversationId: string;
  scope: ChatScope;
  content: string;
  replyTo?: string;
}

export interface BotEvents {
  "bot.ready": { adapter: string };
  "message.created": IncomingMessage;
}

export interface Logger {
  debug(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface EventSubscriber {
  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => Awaitable<void>
  ): Dispose;
}

export interface MessageSender {
  send(message: OutgoingMessage): Promise<void>;
  reply(message: IncomingMessage, content: string): Promise<void>;
}

export interface CommandContext {
  message: IncomingMessage;
  command: string;
  args: string[];
  rawArgs: string;
  reply(content: string): Promise<void>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  permission?: MemberRole;
  execute(context: CommandContext): Awaitable<void>;
}

export interface CommandSummary {
  name: string;
  description: string;
  aliases: string[];
  permission: MemberRole;
  plugin: string;
}

export interface CommandRegistry {
  register(command: CommandDefinition): Dispose;
  list(): CommandSummary[];
}

export interface Scheduler {
  every(name: string, intervalMs: number, task: () => Awaitable<void>): Dispose;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface PluginContext {
  readonly pluginName: string;
  readonly events: EventSubscriber;
  readonly commands: CommandRegistry;
  readonly messages: MessageSender;
  readonly scheduler: Scheduler;
  readonly store: KeyValueStore;
  readonly logger: Logger;
}

export interface BotPlugin {
  name: string;
  version: string;
  description?: string;
  setup(context: PluginContext): Awaitable<void | Dispose>;
}

export function definePlugin(plugin: BotPlugin): BotPlugin {
  return plugin;
}

export interface BotAdapter {
  readonly name: string;
  start(onMessage: (message: IncomingMessage) => Awaitable<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
}
