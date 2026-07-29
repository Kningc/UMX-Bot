export type Awaitable<T> = T | Promise<T>;
export type Dispose = () => Awaitable<void>;
export const LEGACY_PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_API_VERSION = 1 as const;
export const SUPPORTED_PLUGIN_API_VERSIONS = [
  LEGACY_PLUGIN_API_VERSION
] as const;

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
  botMentioned?: boolean;
  timestamp: Date;
  raw?: unknown;
}

export interface SentMessage {
  platform: string;
  scope: ChatScope;
  conversationId: string;
  id: string;
  timestamp: Date;
  raw?: unknown;
}

export type OutgoingMediaKind = "image" | "video" | "audio" | "file";

export type OutgoingMediaSource =
  | { type: "url"; url: string }
  | { type: "data"; data: Uint8Array }
  | {
      type: "stream";
      stream: AsyncIterable<Uint8Array>;
      size: number;
      checksums: readonly MediaChecksum[];
    };

export interface MediaChecksum {
  algorithm: string;
  digest: string;
  /** When present, the digest covers only the first N bytes. */
  bytes?: number;
}

export interface OutgoingMedia {
  type: OutgoingMediaKind;
  source: OutgoingMediaSource;
  filename?: string;
  contentType?: string;
}

export interface RichMessageContent {
  text?: string;
  markdown?: string;
  media?: readonly [OutgoingMedia, ...OutgoingMedia[]];
  keyboard?: MessageKeyboard;
}

export type MessageContent = string | RichMessageContent;

export interface MessageKeyboardButtonBase {
  id?: string;
  label: string;
  style?: "default" | "primary" | "success" | "danger";
  visibleTo?: {
    userIds?: string[];
    /** Display hint only; command permission must still enforce authorization. */
    minimumRole?: MemberRole;
  };
}

export type MessageKeyboardButton = MessageKeyboardButtonBase &
  (
    | {
        action: "command";
        data: string;
        enter?: boolean;
        reply?: boolean;
      }
    | {
        action: "callback";
        data: string;
      }
    | {
        action: "link";
        url: string;
      }
  );

export interface CustomMessageKeyboard {
  rows: readonly (readonly MessageKeyboardButton[])[];
}

export interface PlatformMessageKeyboard {
  platform: string;
  kind: string;
  id: string;
}

export type MessageKeyboard = CustomMessageKeyboard | PlatformMessageKeyboard;

export type ReplyTarget =
  | { type: "message"; messageId: string }
  | { type: "event"; eventId: string };

export type MessageDelivery =
  | { type: "passive"; target: ReplyTarget }
  | { type: "active"; idempotencyKey: string }
  | {
      type: "platform";
      platform: string;
      mode: string;
      idempotencyKey: string;
    };

export interface MessageReference {
  messageId: string;
  ignoreGetMessageError?: boolean;
}

export interface OutgoingMessage {
  conversationId: string;
  scope: ChatScope;
  content: MessageContent;
  delivery: MessageDelivery;
  reference?: MessageReference;
}

export interface ContactEvent {
  platform: string;
  userId: string;
  eventId?: string;
  timestamp: Date;
  raw?: unknown;
}

export interface BotConversationEvent {
  platform: string;
  scope: Exclude<ChatScope, "guild">;
  conversationId: string;
  eventId?: string;
  timestamp: Date;
  raw?: unknown;
}

export interface DeliveryPreferenceEvent extends BotConversationEvent {
  enabled: boolean;
}

export interface InteractionEvent extends BotConversationEvent {
  interactionId?: string;
  userId?: string;
}

export interface PlatformEvent {
  platform: string;
  type: string;
  eventId?: string;
  sequence?: number;
  timestamp: Date;
  raw: Readonly<unknown>;
}

export interface BotEvents {
  "bot.ready": { adapter: string };
  "bot.stopping": { adapter: string };
  "bot.stopped": { adapter: string };
  "message.created": IncomingMessage;
  "contact.added": ContactEvent;
  "contact.removed": ContactEvent;
  "bot.conversation.joined": BotConversationEvent;
  "bot.conversation.left": BotConversationEvent;
  "message.delivery.enabled": DeliveryPreferenceEvent;
  "message.delivery.disabled": DeliveryPreferenceEvent;
  "interaction.created": InteractionEvent;
  "platform.event": PlatformEvent;
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
  send(message: OutgoingMessage): Promise<SentMessage>;
  reply(
    message: IncomingMessage,
    content: MessageContent
  ): Promise<SentMessage>;
  recall(message: SentMessage): Promise<void>;
  setTyping(
    conversation: ConversationRef,
    seconds: number,
    target: ReplyTarget
  ): Promise<void>;
  openStream(options: MessageStreamOptions): Promise<MessageStream>;
  supports(capability: MessagingCapability): boolean;
}

export type MessagingCapability =
  | "send"
  | "recall"
  | "typing"
  | "stream";

export interface MessageStreamOptions {
  conversation: ConversationRef & { scope: "direct" };
  delivery: MessageDelivery;
  contentType: "text" | "markdown";
  initialContent: string;
  inputMode?: "append" | "replace";
}

export type MessageStreamState =
  | "open"
  | "completed"
  | "failed"
  | "uncertain"
  | "aborted";

export interface MessageStream {
  readonly id: string;
  readonly index: number;
  readonly state: MessageStreamState;
  append(content: string): Promise<SentMessage>;
  replace(content: string): Promise<SentMessage>;
  complete(content?: string): Promise<SentMessage>;
  retry(): Promise<SentMessage>;
  abort(content?: string): Promise<SentMessage>;
}

export interface CommandContext {
  message: IncomingMessage;
  command: string;
  args: string[];
  rawArgs: string;
  reply(content: MessageContent): Promise<SentMessage>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  permission?: MemberRole;
  /** Argument syntax only. The framework adds the configured prefix and name. */
  usage?: string;
  examples?: readonly CommandExampleDefinition[];
  hidden?: boolean;
  cooldownMs?: number;
  execute(context: CommandContext): Awaitable<void | SentMessage>;
}

export interface CommandExampleDefinition {
  /** Example arguments only. Omit for the bare command. */
  args?: string;
  description?: string;
}

export interface CommandExampleSummary {
  command: string;
  description?: string;
}

export interface PluginHelpDefinition {
  title?: string;
  description?: string;
  order?: number;
  listed?: boolean;
}

export interface PluginHelpSummary {
  name: string;
  title: string;
  description?: string;
  order: number;
  listed: boolean;
}

export interface CommandSummary {
  name: string;
  invocation: string;
  description: string;
  aliases: string[];
  aliasInvocations: string[];
  permission: MemberRole;
  plugin: PluginHelpSummary;
  usage: string;
  examples: CommandExampleSummary[];
  hidden: boolean;
}

export interface CommandRegistry {
  register(command: CommandDefinition): Dispose;
  list(): CommandSummary[];
  format(name: string, args?: string): string;
}

export interface NavigationItemDefinition {
  id?: string;
  label: string;
  /** Registered command name without a prefix. */
  command: string;
  /** Static arguments appended to the command. */
  args?: string;
  description?: string;
  featured?: boolean;
  order?: number;
  permission?: MemberRole;
  scopes?: ChatScope[];
}

export interface NavigationPageDefinition {
  id?: string;
  /** Overrides the plugin help title for this page. */
  title?: string;
  description?: string;
  order?: number;
  items: readonly [
    NavigationItemDefinition,
    ...NavigationItemDefinition[]
  ];
}

export interface NavigationItemSummary
  extends Omit<
    NavigationItemDefinition,
    "id" | "scopes" | "command" | "args"
  > {
  id: string;
  commandName: string;
  command: string;
  scopes: ChatScope[];
}

export interface NavigationPageSummary
  extends Omit<NavigationPageDefinition, "id" | "items" | "title"> {
  id: string;
  plugin: PluginHelpSummary;
  title: string;
  items: NavigationItemSummary[];
}

export interface NavigationRegistry {
  register(page: NavigationPageDefinition): Dispose;
  list(): NavigationPageSummary[];
}

export interface MessageMiddlewareContext {
  readonly message: IncomingMessage;
  readonly state: Map<string, unknown>;
  handled: boolean;
  reply(content: MessageContent): Promise<SentMessage>;
}

export type MessageMiddleware = (
  context: MessageMiddlewareContext,
  next: () => Promise<void>
) => Awaitable<void | SentMessage>;

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

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
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

export interface PluginContext<
  TConfig extends object = Record<string, unknown>
> {
  readonly pluginName: string;
  /**
   * Host-provided, validated startup configuration. Conversation-adjustable
   * settings belong in `settings` instead.
   */
  readonly config: DeepReadonly<TConfig>;
  readonly signal: AbortSignal;
  readonly events: EventSubscriber;
  readonly commands: CommandRegistry;
  readonly navigation: NavigationRegistry;
  readonly middleware: MiddlewareRegistry;
  readonly messages: MessageSender;
  readonly scheduler: Scheduler;
  readonly store: KeyValueStore;
  readonly settings: SettingsRegistry;
  readonly state: ScopedStateRegistry;
  readonly services: ServiceRegistry;
  readonly logger: Logger;
}

export interface PluginConfigurationDefinition<TConfig extends object> {
  parse(value: unknown): TConfig;
}

export interface BotPlugin<
  TConfig extends object = object
> {
  name: string;
  version: string;
  /** Plugin contract version. Omitted values are always treated as legacy API v1. */
  apiVersion?: number;
  description?: string;
  help?: PluginHelpDefinition;
  dependencies?: PluginDependency[];
  configuration?: PluginConfigurationDefinition<TConfig>;
  setup(context: PluginContext<TConfig>): Awaitable<void | Dispose>;
}

export type PluginDependency =
  | string
  | {
      name: string;
      /** Supported SemVer range, for example ^1.2.0 or >=1.2.0 <2.0.0. */
      version?: string;
      optional?: boolean;
    };

export function definePlugin<TConfig extends object>(
  plugin: BotPlugin<TConfig> & {
    configuration: PluginConfigurationDefinition<TConfig>;
  }
): BotPlugin<TConfig>;
export function definePlugin(
  plugin: BotPlugin<Record<string, unknown>>
): BotPlugin<Record<string, unknown>>;
export function definePlugin<TConfig extends object>(
  plugin: BotPlugin<TConfig>
): BotPlugin<TConfig> {
  return plugin;
}

export interface BotAdapter {
  readonly name: string;
  start(
    onMessage: (message: IncomingMessage) => Awaitable<void>,
    onEvent?: <K extends Exclude<keyof BotEvents, "message.created">>(
      event: K,
      payload: BotEvents[K]
    ) => Awaitable<void>
  ): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<SentMessage>;
  recall?(message: SentMessage): Promise<void>;
  setTyping?(
    conversation: ConversationRef,
    seconds: number,
    target: ReplyTarget
  ): Promise<void>;
  openMessageStream?(options: MessageStreamOptions): Promise<MessageStream>;
  checkHealth?(): Promise<void>;
  getDiagnostics?(): Readonly<Record<string, unknown>>;
}
