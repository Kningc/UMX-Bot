export type Awaitable<T> = T | Promise<T>;
export type Dispose = () => Awaitable<void>;

export type ChatScope = "group" | "direct" | "guild";
export type MemberRole = "member" | "admin" | "owner";

export interface MessageAuthor {
  id: string;
  name?: string;
  role: MemberRole;
}

export interface MessageAttachment {
  url: string;
  filename?: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface MessageMention {
  id: string;
  name?: string;
}

export interface IncomingMessage {
  id: string;
  platform: string;
  scope: ChatScope;
  conversationId: string;
  author: MessageAuthor;
  content: string;
  attachments: MessageAttachment[];
  mentions: MessageMention[];
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
  "bot.stopping": { adapter: string };
  "bot.stopped": { adapter: string };
  "message.created": IncomingMessage;
}

export interface Logger {
  debug(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface EventSubscriptionOptions {
  priority?: number;
  once?: boolean;
}

export interface EventSubscriber {
  on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => Awaitable<void>,
    options?: EventSubscriptionOptions
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
  usage?: string;
  hidden?: boolean;
  cooldownMs?: number;
  execute(context: CommandContext): Awaitable<void>;
}

export interface CommandSummary {
  name: string;
  description: string;
  aliases: string[];
  permission: MemberRole;
  plugin: string;
  usage?: string;
  hidden: boolean;
}

export interface CommandRegistry {
  register(command: CommandDefinition): Dispose;
  list(): CommandSummary[];
}

export interface MessageMiddlewareContext {
  readonly message: IncomingMessage;
  readonly state: Map<string, unknown>;
  handled: boolean;
  reply(content: string): Promise<void>;
}

export type MessageMiddleware = (
  context: MessageMiddlewareContext,
  next: () => Promise<void>
) => Awaitable<void>;

export interface MiddlewareOptions {
  priority?: number;
}

export interface MiddlewareRegistry {
  use(middleware: MessageMiddleware, options?: MiddlewareOptions): Dispose;
}

export interface ScheduleOptions {
  runImmediately?: boolean;
  overlap?: "skip" | "allow";
}

export interface Scheduler {
  every(
    name: string,
    intervalMs: number,
    task: (signal: AbortSignal) => Awaitable<void>,
    options?: ScheduleOptions
  ): Dispose;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined>;
}

export interface ConversationRef {
  platform: string;
  scope: ChatScope;
  conversationId: string;
}

export type SettingsScope =
  | { level: "global" }
  | { level: "platform"; platform: string }
  | { level: "chat"; platform: string; scope: ChatScope }
  | {
      level: "conversation";
      platform: string;
      scope: ChatScope;
      conversationId: string;
    };

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface SettingsSchema<T> {
  parse(value: unknown): T;
}

export interface SettingsDefinition<T extends object> {
  key?: string;
  defaults: T;
  schema?: SettingsSchema<T>;
  version?: number;
  migrate?: (stored: unknown, fromVersion: number) => unknown;
}

export interface SettingsInspection<T extends object> {
  value: T;
  layers: {
    defaults: T;
    global?: DeepPartial<T>;
    platform?: DeepPartial<T>;
    chat?: DeepPartial<T>;
    conversation?: DeepPartial<T>;
  };
}

export interface ScopedSettings<T extends object> {
  get(target: ConversationRef): Promise<T>;
  inspect(target: ConversationRef): Promise<SettingsInspection<T>>;
  getOverrides(scope: SettingsScope): Promise<DeepPartial<T> | undefined>;
  set(
    scope: SettingsScope,
    overrides: DeepPartial<T>
  ): Promise<T>;
  update(
    scope: SettingsScope,
    updater: (current: DeepPartial<T>) => DeepPartial<T>
  ): Promise<T>;
  reset(scope: SettingsScope): Promise<boolean>;
}

export interface SettingsRegistry {
  define<T extends object>(
    definition: SettingsDefinition<T>
  ): ScopedSettings<T>;
}

export interface ScopedStateRegistry {
  forConversation(target: ConversationRef): KeyValueStore;
  forScope(scope: SettingsScope): KeyValueStore;
}

export interface ServiceToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly _type?: (value: T) => T;
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
  if (name.trim().length === 0) {
    throw new Error("service token name cannot be empty");
  }
  return Object.freeze({
    id: Symbol(name),
    name
  }) as ServiceToken<T>;
}

export interface ServiceRegistry {
  provide<T>(token: ServiceToken<T>, service: T): Dispose;
  get<T>(token: ServiceToken<T>): T;
  has<T>(token: ServiceToken<T>): boolean;
}

export interface PluginContext {
  readonly pluginName: string;
  readonly signal: AbortSignal;
  readonly events: EventSubscriber;
  readonly commands: CommandRegistry;
  readonly middleware: MiddlewareRegistry;
  readonly messages: MessageSender;
  readonly scheduler: Scheduler;
  readonly store: KeyValueStore;
  readonly settings: SettingsRegistry;
  readonly state: ScopedStateRegistry;
  readonly services: ServiceRegistry;
  readonly logger: Logger;
}

export interface BotPlugin {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[];
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
