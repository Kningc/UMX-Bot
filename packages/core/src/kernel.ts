import type {
  BotAdapter,
  BotEvents,
  BotPlugin,
  IncomingMessage,
  InteractionEvent,
  KeyValueStore,
  Logger,
  MessageSender,
  NavigationPageSummary,
  OutgoingMessage
} from "@umx-bot/plugin-sdk";
import { helpService } from "@umx-bot/plugin-sdk";
import type { AccessPolicy } from "./access-policy.js";
import { StoreAccessPolicy } from "./access-policy.js";
import { CommandRouter } from "./command-router.js";
import { EventBus } from "./event-bus.js";
import { InteractionRouter } from "./interaction-router.js";
import { MemoryStore } from "./memory-store.js";
import { MetricsRegistry } from "./metrics-registry.js";
import { MiddlewarePipeline } from "./middleware-pipeline.js";
import { BotNavigationRegistry } from "./navigation-registry.js";
import { OutboundPipeline } from "./outbound-pipeline.js";
import type {
  ContextExtension,
  PluginLoadOptions,
  PluginSnapshot
} from "./plugin-runtime.js";
import { PluginRuntime } from "./plugin-runtime.js";
import { IntervalScheduler } from "./scheduler.js";
import { ServiceContainer } from "./service-container.js";
import { SettingsCatalog } from "./settings-catalog.js";

export type BotKernelState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface BotKernelHealth {
  state: BotKernelState;
  adapter: string;
  startedAt?: Date;
  uptimeMs: number;
  inFlightMessages: number;
  metrics: {
    received: number;
    processed: number;
    failed: number;
    commandsHandled: number;
    /**
     * End-to-end message handling latency: middleware, event handlers and the
     * command itself. Shaped for a Prometheus histogram.
     */
    processingLatency: {
      count: number;
      totalMs: number;
      maxMs: number;
      /** Cumulative counts keyed by upper bound in milliseconds. */
      buckets: { leMs: number; count: number }[];
    };
  };
  adapterDiagnostics?: Readonly<Record<string, unknown>>;
  plugins: PluginSnapshot[];
}

export interface BotKernelOptions {
  adapter: BotAdapter;
  logger: Logger;
  commandPrefix?: string;
  store?: KeyValueStore;
  shutdownTimeoutMs?: number;
  /**
   * Platform user ids treated as `owner` in every conversation and marked
   * `author.botOwner`, which `botOwnerOnly` commands require.
   *
   * Platform roles only describe a single group, so without this the operator
   * of a self-hosted bot has no way to reach owner-level commands in a group
   * they do not administer. Applied centrally, so commands, navigation and
   * plugins all see the same role.
   */
  ownerIds?: readonly string[];
  /**
   * Extra per-command gate (per-chat switches, blocklists, …). Defaults to a
   * `StoreAccessPolicy` over `store`.
   */
  accessPolicy?: AccessPolicy;
  /** Capabilities added to every plugin's context; see `requires`. */
  contextExtensions?: readonly ContextExtension[];
}

export class BotKernel {
  private readonly adapter: BotAdapter;
  private readonly logger: Logger;
  private readonly events: EventBus;
  private readonly commands: CommandRouter;
  private readonly navigation: BotNavigationRegistry;
  private readonly middleware: MiddlewarePipeline;
  private readonly plugins: PluginRuntime;
  private readonly interactions: InteractionRouter;
  private readonly metricsRegistry = new MetricsRegistry();
  /** Settings every loaded plugin defined, for generic admin tooling. */
  public readonly settings = new SettingsCatalog();
  private readonly shutdownTimeoutMs: number;
  private readonly ownerIds: ReadonlySet<string>;
  private state: BotKernelState = "created";
  private startedAt: Date | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly pendingPluginLoads = new Set<Promise<void>>();
  private readonly inFlightMessages = new Set<Promise<void>>();
  private readonly metrics = {
    received: 0,
    processed: 0,
    failed: 0,
    commandsHandled: 0
  };
  private readonly latency = new LatencyHistogram();

  public constructor(options: BotKernelOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.ownerIds = new Set(
      (options.ownerIds ?? [])
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    );
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs <= 0
    ) {
      throw new Error("shutdown timeout must be a positive integer");
    }

    const outbound = new OutboundPipeline();
    const sendOutbound = (message: OutgoingMessage) =>
      outbound.send(message, (final) => this.adapter.send(final));
    const messages: MessageSender = {
      send: sendOutbound,
      reply: (message, content) =>
        sendOutbound({
          conversationId: message.conversationId,
          scope: message.scope,
          content,
          delivery: {
            type: "passive",
            target: { type: "message", messageId: message.id }
          }
        }),
      recall: (message) => {
        if (!this.adapter.recall) {
          throw new Error(
            `adapter "${this.adapter.name}" does not support message recall`
          );
        }
        return this.adapter.recall(message);
      },
      setTyping: (conversation, seconds, target) => {
        if (!this.adapter.setTyping) {
          throw new Error(
            `adapter "${this.adapter.name}" does not support typing status`
          );
        }
        return this.adapter.setTyping(conversation, seconds, target);
      },
      openStream: (options) => {
        if (!this.adapter.openMessageStream) {
          throw new Error(
            `adapter "${this.adapter.name}" does not support message streams`
          );
        }
        return this.adapter.openMessageStream(options);
      },
      supports: (capability) =>
        capability === "send" ||
        (capability === "recall" && this.adapter.recall !== undefined) ||
        (capability === "typing" && this.adapter.setTyping !== undefined) ||
        (capability === "stream" &&
          this.adapter.openMessageStream !== undefined)
    };

    const store = options.store ?? new MemoryStore();
    const commandCount = this.metricsRegistry.counter(
      "qq_bot_command_executions_total",
      "Command attempts by plugin, command and outcome.",
      ["plugin", "command", "outcome"]
    );
    const commandDuration = this.metricsRegistry.histogram(
      "qq_bot_command_duration_seconds",
      "Command execution time.",
      ["plugin", "command"]
    );
    const taskRuns = this.metricsRegistry.counter(
      "qq_bot_scheduled_task_runs_total",
      "Scheduled task runs by task and outcome.",
      ["task", "outcome"]
    );
    const taskDuration = this.metricsRegistry.histogram(
      "qq_bot_scheduled_task_duration_seconds",
      "Scheduled task execution time.",
      ["task"]
    );

    this.events = new EventBus(options.logger);
    this.middleware = new MiddlewarePipeline(messages);
    const commandPrefix = options.commandPrefix ?? "/";
    const services = new ServiceContainer();
    this.commands = new CommandRouter(commandPrefix, messages, options.logger, {
      access: options.accessPolicy ?? new StoreAccessPolicy(store),
      subcommandHelp: async (message, command) =>
        services.lookup(helpService)?.render(message, command),
      onExecuted: async (event) => {
        commandCount.inc({
          plugin: event.plugin,
          command: event.command,
          outcome: event.outcome
        });
        commandDuration.observe(event.durationMs / 1000, {
          plugin: event.plugin,
          command: event.command
        });
        await this.events.emit("command.executed", event);
      }
    });
    this.navigation = new BotNavigationRegistry(commandPrefix);
    this.interactions = new InteractionRouter((event, content) => {
      if (!event.eventId) {
        throw new Error("interaction carries no event id to reply to");
      }
      return sendOutbound({
        conversationId: event.conversationId,
        scope: event.scope,
        content,
        delivery: {
          type: "passive",
          target: { type: "event", eventId: event.eventId }
        }
      });
    }, options.logger);
    this.plugins = new PluginRuntime(
      this.events,
      this.commands,
      this.navigation,
      this.middleware,
      messages,
      new IntervalScheduler(options.logger, {
        store,
        onRun: (task, outcome, durationMs) => {
          taskRuns.inc({ task, outcome });
          if (outcome !== "skipped") {
            taskDuration.observe(durationMs / 1000, { task });
          }
        }
      }),
      store,
      services,
      options.logger,
      {
        ...(options.contextExtensions
          ? { extensions: options.contextExtensions }
          : {}),
        settingsCatalog: this.settings,
        metrics: this.metricsRegistry,
        interactions: this.interactions,
        outbound
      }
    );
  }

  /**
   * Loads a plugin before start, or into a running bot.
   *
   * A plugin loaded while the bot is running does **not** receive `bot.ready`:
   * that event means "the bot has started", which already happened, and firing
   * it again would re-run the startup work of every other plugin. Startup work
   * for a hot-loaded plugin belongs in `setup()`.
   *
   * Navigation is re-synced afterwards so the new plugin's menu entries show
   * up without a restart.
   */
  public async load(
    plugin: BotPlugin,
    options: PluginLoadOptions = {}
  ): Promise<void> {
    if (this.state !== "created" && this.state !== "running") {
      throw new Error(`cannot load plugins while kernel is ${this.state}`);
    }
    const hotLoad = this.state === "running";
    const loading = this.plugins.load(plugin, options);
    this.pendingPluginLoads.add(loading);
    try {
      await loading;
    } finally {
      this.pendingPluginLoads.delete(loading);
    }
    if (hotLoad) {
      await this.resyncNavigation();
    }
  }

  /**
   * Unloads a plugin and releases everything it registered.
   *
   * Returns false when no such plugin is loaded, and throws when another
   * loaded plugin depends on it.
   */
  public async unload(name: string): Promise<boolean> {
    if (this.state !== "created" && this.state !== "running") {
      throw new Error(`cannot unload plugins while kernel is ${this.state}`);
    }
    const unloaded = await this.plugins.unload(name);
    if (unloaded && this.state === "running") {
      await this.resyncNavigation();
    }
    return unloaded;
  }

  /**
   * Pushes the current navigation to the adapter again.
   *
   * A failure here must not take the bot down: the plugin change already
   * happened, and stale platform menus are a cosmetic problem next to a
   * crashed process.
   */
  private async resyncNavigation(): Promise<void> {
    try {
      await this.adapter.syncNavigation?.(
        this.navigation.list(),
        this.commands.list()
      );
    } catch (error) {
      this.logger.error(
        { error },
        "navigation re-sync after a plugin change failed"
      );
    }
  }

  public async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.state !== "created") {
      throw new Error(`cannot start kernel while it is ${this.state}`);
    }

    this.startPromise = this.startAfterPluginsLoaded();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  public async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  public getHealth(): BotKernelHealth {
    const startedAt = this.startedAt ? new Date(this.startedAt) : undefined;
    return {
      state: this.state,
      adapter: this.adapter.name,
      ...(startedAt ? { startedAt } : {}),
      uptimeMs: startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : 0,
      inFlightMessages: this.inFlightMessages.size,
      metrics: { ...this.metrics, processingLatency: this.latency.snapshot() },
      ...(this.adapter.getDiagnostics
        ? { adapterDiagnostics: this.adapter.getDiagnostics() }
        : {}),
      plugins: this.plugins.snapshot()
    };
  }

  /** Prometheus text for kernel and plugin metrics registered by name. */
  public getMetricsText(): string {
    return this.metricsRegistry.render();
  }

  public getNavigation(): NavigationPageSummary[] {
    return this.navigation.list();
  }

  private async startAfterPluginsLoaded(): Promise<void> {
    while (this.pendingPluginLoads.size > 0) {
      await Promise.all([...this.pendingPluginLoads]);
    }
    await this.startInternal();
  }

  private async startInternal(): Promise<void> {
    this.state = "starting";
    try {
      await this.adapter.start(
        (message) => this.handleIncoming(message),
        (event, payload) => this.emitAdapterEvent(event, payload)
      );
      await this.adapter.syncNavigation?.(
        this.navigation.list(),
        this.commands.list()
      );
      this.startedAt = new Date();
      this.state = "running";
      await this.events.emit(
        "bot.ready",
        { adapter: this.adapter.name },
        { errorMode: "throw" }
      );
      this.logger.info({ adapter: this.adapter.name }, "bot started");
    } catch (error) {
      this.state = "failed";
      this.logger.error({ error }, "bot startup failed");
      try {
        await this.adapter.stop();
      } catch (stopError) {
        this.logger.error(
          { error: stopError },
          "adapter rollback after startup failure failed"
        );
      }
      await this.plugins.unloadAll();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    const errors: unknown[] = [];
    if (this.startPromise) {
      this.plugins.cancelLoading();
      if (this.state === "starting") {
        try {
          await this.adapter.stop();
        } catch (error) {
          errors.push(error);
          this.logger.error({ error }, "adapter stop during startup failed");
        }
      }
      try {
        await this.startPromise;
      } catch {
        this.state = "stopped";
        if (errors.length > 0) {
          throw new AggregateError(errors, "bot stopped with errors");
        }
        return;
      }
    }

    this.state = "stopping";
    await this.events.emit("bot.stopping", { adapter: this.adapter.name });

    try {
      await this.adapter.stop();
    } catch (error) {
      errors.push(error);
      this.logger.error({ error }, "adapter stop failed");
    }

    await this.drainMessages();
    await this.events.emit("bot.stopped", { adapter: this.adapter.name });
    try {
      await this.plugins.unloadAll();
    } catch (error) {
      errors.push(error);
      this.logger.error({ error }, "plugin shutdown failed");
    }

    this.state = "stopped";
    this.logger.info({}, "bot stopped");
    if (errors.length > 0) {
      throw new AggregateError(errors, "bot stopped with errors");
    }
  }

  private async handleIncoming(message: IncomingMessage): Promise<void> {
    if (this.state !== "starting" && this.state !== "running") {
      this.logger.warn(
        { messageId: message.id, state: this.state },
        "message ignored while bot is not accepting traffic"
      );
      return;
    }

    this.metrics.received += 1;
    const processing = this.processMessage(this.applyOwnerIds(message));
    this.inFlightMessages.add(processing);
    try {
      await processing;
    } finally {
      this.inFlightMessages.delete(processing);
    }
  }

  /**
   * Marks and elevates a configured bot owner before anything inspects the
   * author. `botOwner` comes only from here: a value an adapter set is
   * dropped, so a platform role such as a QQ group owner never turns into
   * bot-wide authority.
   */
  private applyOwnerIds(message: IncomingMessage): IncomingMessage {
    if (this.ownerIds.has(message.author.id)) {
      if (message.author.role === "owner" && message.author.botOwner === true) {
        return message;
      }
      return {
        ...message,
        author: { ...message.author, role: "owner", botOwner: true }
      };
    }
    if (message.author.botOwner === undefined) {
      return message;
    }
    const { botOwner: _forged, ...author } = message.author;
    return { ...message, author };
  }

  private async processMessage(message: IncomingMessage): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.middleware.run(message, async (context) => {
        await this.events.emit("message.created", message);
        const handled = await this.commands.handle(message);
        if (handled) {
          context.handled = true;
          this.metrics.commandsHandled += 1;
        }
      });
      this.metrics.processed += 1;
    } catch (error) {
      this.metrics.failed += 1;
      this.logger.error(
        { error, messageId: message.id },
        "message processing failed"
      );
      throw error;
    } finally {
      this.latency.observe(performance.now() - startedAt);
    }
  }

  private async emitAdapterEvent<
    K extends Exclude<keyof BotEvents, "message.created">
  >(event: K, payload: BotEvents[K]): Promise<void> {
    await this.events.emit(event, payload);
    if (event === "interaction.created") {
      await this.interactions.route(payload as InteractionEvent);
    }
  }

  private async drainMessages(): Promise<void> {
    if (this.inFlightMessages.size === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), this.shutdownTimeoutMs);
      timeout.unref();
    });
    const drained = Promise.allSettled([...this.inFlightMessages]).then(
      () => "drained" as const
    );
    const result = await Promise.race([drained, timedOut]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (result === "timeout") {
      this.logger.warn(
        {
          inFlightMessages: this.inFlightMessages.size,
          timeoutMs: this.shutdownTimeoutMs
        },
        "graceful shutdown timed out"
      );
    }
  }
}

const LATENCY_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000
];

/**
 * Fixed-bucket histogram. Cheap, allocation-free per observation, and shaped
 * so the ops endpoint can emit it as a Prometheus histogram without keeping
 * every sample.
 */
class LatencyHistogram {
  private readonly counts = new Array<number>(LATENCY_BUCKETS_MS.length).fill(
    0
  );
  private overflow = 0;
  private count = 0;
  private totalMs = 0;
  private maxMs = 0;

  public observe(durationMs: number): void {
    const value = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.count += 1;
    this.totalMs += value;
    if (value > this.maxMs) {
      this.maxMs = value;
    }
    const index = LATENCY_BUCKETS_MS.findIndex((bound) => value <= bound);
    if (index === -1) {
      this.overflow += 1;
      return;
    }
    const bucket = this.counts[index];
    if (bucket !== undefined) {
      this.counts[index] = bucket + 1;
    }
  }

  public snapshot(): BotKernelHealth["metrics"]["processingLatency"] {
    let cumulative = 0;
    const buckets = LATENCY_BUCKETS_MS.map((bound, index) => {
      cumulative += this.counts[index] ?? 0;
      return { leMs: bound, count: cumulative };
    });
    buckets.push({
      leMs: Number.POSITIVE_INFINITY,
      count: cumulative + this.overflow
    });
    return {
      count: this.count,
      totalMs: Math.round(this.totalMs * 1000) / 1000,
      maxMs: Math.round(this.maxMs * 1000) / 1000,
      buckets
    };
  }
}

export type {
  BotAdapter,
  BotPlugin,
  IncomingMessage,
  KeyValueStore,
  Logger,
  OutgoingMessage
} from "@umx-bot/plugin-sdk";
export { MemoryStore } from "./memory-store.js";
