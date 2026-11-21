import type { CommandArgsSchema } from "./command-args.js";

export {
  type Collection,
  type CollectionEntry,
  type CollectionFindOptions,
  createCollection
} from "./collection.js";
export {
  type ArgDefinition,
  type ArgSpec,
  type CommandArgsInput,
  type CommandArgsSchema,
  CommandArgumentError,
  defineArgs,
  type ParsedArgs
} from "./command-args.js";

export type Awaitable<T> = T | Promise<T>;
export type Dispose = () => Awaitable<void>;
export const LEGACY_PLUGIN_API_VERSION = 1 as const;
/**
 * Contract version new plugins should declare.
 *
 * Evolution policy: within a version the contract only grows (new optional
 * fields and methods). A change that could break an existing plugin bumps the
 * version, and the runtime keeps accepting older versions listed in
 * `SUPPORTED_PLUGIN_API_VERSIONS` for at least one major release. v2 added
 * permissions, `requires`, plugin-emitted events, outbound hooks, interaction
 * routing, metrics, cron scheduling, store TTL and command v2 (subcommands,
 * argument schemas, scopes).
 */
export const PLUGIN_API_VERSION = 2 as const;
export const SUPPORTED_PLUGIN_API_VERSIONS = [
  LEGACY_PLUGIN_API_VERSION,
  PLUGIN_API_VERSION
] as const;

/**
 * Powers a plugin must be granted when it declares `permissions` (or when the
 * manifest restricts it). A plugin that declares nothing and has no manifest
 * restriction keeps the legacy unrestricted behaviour.
 */
export const PLUGIN_PERMISSIONS = [
  /** Active or platform-specific delivery and message streams. */
  "messages.active",
  /** Emitting `<plugin>.*` events for other plugins. */
  "events.emit",
  /** Registering interval, cron and one-shot tasks. */
  "scheduler",
  /** Seeing and short-circuiting every incoming message. */
  "middleware",
  /** Seeing and rewriting every outgoing message. */
  "outbound"
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Thrown when a restricted plugin uses a power it was not granted. */
export class PermissionError extends Error {
  public constructor(
    public readonly plugin: string,
    public readonly permission: PluginPermission
  ) {
    super(`plugin "${plugin}" needs the "${permission}" permission`);
    this.name = "PermissionError";
  }
}

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

/** A message quoted by the incoming message. Presence indicates a quote/reply. */
export interface MessageQuote {
  /** Original quoted text, or an empty string when the platform omitted it. */
  content: string;
  /** Opaque platform reference for the quoted message, when available. */
  referenceId?: string;
  attachments: MessageAttachment[];
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
  quote?: MessageQuote;
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
  /** Payload of the pressed `callback` button, when the platform sent one. */
  data?: string;
  buttonId?: string;
}

export type CommandOutcome = "completed" | "failed" | "denied" | "rejected";

export interface CommandExecutedEvent {
  command: string;
  subcommand?: string;
  plugin: string;
  outcome: CommandOutcome;
  /** Why a command was `rejected`: scope, access, cooldown or arguments. */
  reason?: "access" | "cooldown" | "arguments";
  durationMs: number;
  message: IncomingMessage;
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
  "command.executed": CommandExecutedEvent;
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

export interface EventPublisher {
  /**
   * Publishes an event to other plugins. Only names under the plugin's own
   * namespace (`<plugin>.…`) are accepted, so a plugin cannot forge built-in
   * events. Declare payload types by augmenting `BotEvents`.
   */
  emit<K extends keyof BotEvents>(
    event: K,
    payload: BotEvents[K]
  ): Promise<void>;
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

export type MessagingCapability = "send" | "recall" | "typing" | "stream";

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

export interface CommandContext<TArgs = unknown> {
  message: IncomingMessage;
  command: string;
  /** Set when a subcommand was selected. `args` then excludes its name. */
  subcommand?: string;
  args: string[];
  rawArgs: string;
  /** Result of the command's `args` schema; `undefined` without a schema. */
  parsed: TArgs;
  /** Logger bound to the plugin, command and message id. */
  logger: Logger;
  reply(content: MessageContent): Promise<SentMessage>;
}

interface CommandBase<TArgs> {
  description: string;
  aliases?: string[];
  permission?: MemberRole;
  /** Argument syntax only. The framework adds the configured prefix and name. */
  usage?: string;
  examples?: readonly CommandExampleDefinition[];
  hidden?: boolean;
  cooldownMs?: number;
  /** Chats the command works in. Elsewhere it behaves as if unregistered. */
  scopes?: readonly ChatScope[];
  /** Validates and types the arguments before `execute` runs. */
  args?: CommandArgsSchema<TArgs>;
}

export interface SubcommandDefinition<TArgs = unknown>
  extends CommandBase<TArgs> {
  name: string;
  execute(context: CommandContext<TArgs>): Awaitable<void | SentMessage>;
}

export interface CommandDefinition<TArgs = unknown> extends CommandBase<TArgs> {
  name: string;
  /**
   * `/name <sub> …` runs the matching subcommand. Subcommands inherit the
   * parent's permission, scopes and cooldown unless they set their own.
   */
  // biome-ignore lint/suspicious/noExplicitAny: each subcommand has its own argument type
  subcommands?: readonly SubcommandDefinition<any>[];
  /**
   * Runs when no subcommand matches. Optional only when `subcommands` is
   * set, in which case the framework replies with the subcommand list.
   */
  execute?(context: CommandContext<TArgs>): Awaitable<void | SentMessage>;
}

/** Typing helper that infers a subcommand's `TArgs` from its `args` schema. */
export function defineSubcommand<TArgs>(
  subcommand: SubcommandDefinition<TArgs>
): SubcommandDefinition<TArgs> {
  return subcommand;
}

/** Typing helper that infers `TArgs` from the `args` schema. */
export function defineCommand<TArgs>(
  command: CommandDefinition<TArgs>
): CommandDefinition<TArgs> {
  return command;
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

export interface SubcommandSummary {
  name: string;
  invocation: string;
  description: string;
  aliases: string[];
  permission: MemberRole;
  usage: string;
  examples: CommandExampleSummary[];
  hidden: boolean;
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
  /** Present only when the command is restricted to some chats. */
  scopes?: ChatScope[];
  /** Present only when the command has subcommands. */
  subcommands?: SubcommandSummary[];
}

export interface CommandRegistry {
  register<TArgs = unknown>(command: CommandDefinition<TArgs>): Dispose;
  list(): CommandSummary[];
  format(name: string, args?: string): string;
}

export type NavigationSurface = "message" | "menu" | "panel";

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
  /** Places where adapters may expose this entry. Defaults to message only. */
  surfaces?: NavigationSurface[];
}

export interface NavigationPageDefinition {
  id?: string;
  /** Overrides the plugin help title for this page. */
  title?: string;
  description?: string;
  order?: number;
  items: readonly [NavigationItemDefinition, ...NavigationItemDefinition[]];
}

export interface NavigationItemSummary
  extends Omit<
    NavigationItemDefinition,
    "id" | "scopes" | "surfaces" | "command" | "args"
  > {
  id: string;
  commandName: string;
  command: string;
  args?: string;
  scopes: ChatScope[];
  surfaces: NavigationSurface[];
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

export type OutboundHook = (
  message: OutgoingMessage,
  /**
   * Continues to the next hook and finally the adapter. Pass a replacement
   * message to rewrite it, call it more than once to split it, or do not call
   * it to block the message (throw, or return a `SentMessage` you built).
   */
  next: (message?: OutgoingMessage) => Promise<SentMessage>
) => Awaitable<SentMessage>;

export interface OutboundRegistry {
  /**
   * Higher priority runs first. Covers `messages.send` and `reply`; adapter
   * internals such as message streams and recalls bypass it.
   */
  use(hook: OutboundHook, options?: { priority?: number }): Dispose;
}

export interface InteractionContext {
  event: InteractionEvent;
  /** The registered action name. */
  action: string;
  /** Everything after `<plugin>:<action>:` in the button data. */
  payload: string;
  reply(content: MessageContent): Promise<SentMessage>;
}

export interface InteractionRegistry {
  /**
   * Handles presses of `callback` buttons whose data was built with
   * `encode(action, payload)`. Routing is by plugin name, so two plugins can
   * both use an action called `refresh`.
   */
  handle(
    action: string,
    handler: (context: InteractionContext) => Awaitable<void>
  ): Dispose;
  /** Builds button `data` that routes back to this plugin's handler. */
  encode(action: string, payload?: string): string;
}

export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface Counter {
  inc(labels?: MetricLabels, value?: number): void;
}

export interface Gauge {
  set(value: number, labels?: MetricLabels): void;
  add(value: number, labels?: MetricLabels): void;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

export interface MetricOptions {
  /** Label names. Every update must pass exactly these. */
  labels?: readonly string[];
}

export interface MetricsRegistry {
  /**
   * Metrics are exported as `qq_bot_plugin_<plugin>_<name>`. Keep label values
   * low-cardinality (a few dozen at most): never a user or message id.
   */
  counter(name: string, help: string, options?: MetricOptions): Counter;
  gauge(name: string, help: string, options?: MetricOptions): Gauge;
  histogram(
    name: string,
    help: string,
    options?: MetricOptions & { buckets?: readonly number[] }
  ): Histogram;
}

export interface ScheduleOptions {
  runImmediately?: boolean;
  overlap?: "skip" | "allow";
}

export interface CronOptions {
  /** Defaults to the process local time. */
  timezone?: "local" | "utc";
  overlap?: "skip" | "allow";
  /**
   * Run once at startup when at least one fire time was missed while the bot
   * was down. The last run is persisted per task.
   */
  catchUp?: boolean;
}

export interface Scheduler {
  every(
    name: string,
    intervalMs: number,
    task: (signal: AbortSignal) => Awaitable<void>,
    options?: ScheduleOptions
  ): Dispose;
  /**
   * Five-field cron (`minute hour day-of-month month day-of-week`) with `*`,
   * lists, ranges and `/step`. When both day fields are restricted a day
   * matches if either does, as in classic cron.
   */
  cron(
    name: string,
    expression: string,
    task: (signal: AbortSignal) => Awaitable<void>,
    options?: CronOptions
  ): Dispose;
  /** Runs once at `when` (immediately when it is already past). */
  at(
    name: string,
    when: Date,
    task: (signal: AbortSignal) => Awaitable<void>
  ): Dispose;
}

export interface KeyValueEntry<T> {
  key: string;
  value: T;
}

export interface KeyValueListOptions {
  // `| undefined` is explicit because the workspace compiles with
  // `exactOptionalPropertyTypes`: callers naturally hold `string | undefined`
  // (e.g. `entries.at(-1)?.key`) and should not have to narrow it first.
  /** Maximum number of entries to return. Implementations may cap this. */
  limit?: number | undefined;
  /** Exclusive lower bound, for paging through a large prefix. */
  after?: string | undefined;
}

export interface KeyValueSetOptions {
  /**
   * Expire the entry after this many milliseconds. Expired entries read as
   * missing and are skipped by `list`. Stores that cannot expire entries
   * ignore it, so treat it as a space optimisation, not as a guarantee.
   * `update` keeps the entry's existing expiry.
   */
  ttlMs?: number | undefined;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: KeyValueSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined>;
  /**
   * Lists the entries whose key starts with `prefix`, in ascending key order.
   *
   * Optional, because not every backing store can scan keys. Callers must
   * treat a missing implementation as "enumeration is unavailable" and never
   * as "there are no entries" — see `supportsListing()`.
   */
  list?<T>(
    prefix: string,
    options?: KeyValueListOptions
  ): Promise<KeyValueEntry<T>[]>;
}

export interface ListableKeyValueStore extends KeyValueStore {
  list<T>(
    prefix: string,
    options?: KeyValueListOptions
  ): Promise<KeyValueEntry<T>[]>;
}

export function supportsListing(
  store: KeyValueStore
): store is ListableKeyValueStore {
  return typeof store.list === "function";
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
  set(scope: SettingsScope, overrides: DeepPartial<T>): Promise<T>;
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

/**
 * Capabilities a host adds with a context extension. Augment it to type them:
 *
 * ```ts
 * declare module "@qq-bot/plugin-sdk" {
 *   interface PluginContextExtensions { readonly db: MyDatabase }
 * }
 * ```
 * and declare `requires: ["db"]` so the plugin fails to load, with a clear
 * message, on a host that does not provide it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point
export interface PluginContextExtensions {}

export interface PluginContext<TConfig extends object = Record<string, unknown>>
  extends PluginContextExtensions {
  readonly pluginName: string;
  /**
   * Host-provided, validated startup configuration. Conversation-adjustable
   * settings belong in `settings` instead.
   */
  readonly config: DeepReadonly<TConfig>;
  readonly signal: AbortSignal;
  readonly events: EventSubscriber & EventPublisher;
  readonly commands: CommandRegistry;
  readonly navigation: NavigationRegistry;
  readonly middleware: MiddlewareRegistry;
  readonly outbound: OutboundRegistry;
  readonly interactions: InteractionRegistry;
  readonly metrics: MetricsRegistry;
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

export interface BotPlugin<TConfig extends object = object> {
  name: string;
  version: string;
  /** Plugin contract version. Omitted values are always treated as legacy API v1. */
  apiVersion?: number;
  description?: string;
  help?: PluginHelpDefinition;
  dependencies?: PluginDependency[];
  /**
   * Powers this plugin needs. Declaring any switches the plugin to the
   * restricted model: powers not listed (or not granted by the manifest) throw
   * `PermissionError` when used. Omit for the legacy unrestricted behaviour.
   */
  permissions?: readonly PluginPermission[];
  /**
   * Host capabilities the plugin cannot work without: `messages.recall`,
   * `messages.typing`, `messages.stream`, or the name of a context extension.
   * Checked at load time.
   */
  requires?: readonly string[];
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
  syncNavigation?(pages: readonly NavigationPageSummary[]): Promise<void>;
  getDiagnostics?(): Readonly<Record<string, unknown>>;
}
