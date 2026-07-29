import type {
  BotAdapter,
  BotPlugin,
  IncomingMessage,
  KeyValueStore,
  Logger,
  MessageSender,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
import { CommandRouter } from "./command-router.js";
import { EventBus } from "./event-bus.js";
import { MemoryStore } from "./memory-store.js";
import { MiddlewarePipeline } from "./middleware-pipeline.js";
import { BotNavigationRegistry } from "./navigation-registry.js";
import { PluginRuntime } from "./plugin-runtime.js";
import type { PluginSnapshot } from "./plugin-runtime.js";
import { IntervalScheduler } from "./scheduler.js";
import { ServiceContainer } from "./service-container.js";

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
  };
  plugins: PluginSnapshot[];
}

export interface BotKernelOptions {
  adapter: BotAdapter;
  logger: Logger;
  commandPrefix?: string;
  store?: KeyValueStore;
  shutdownTimeoutMs?: number;
}

export class BotKernel {
  private readonly adapter: BotAdapter;
  private readonly logger: Logger;
  private readonly events: EventBus;
  private readonly commands: CommandRouter;
  private readonly navigation: BotNavigationRegistry;
  private readonly middleware: MiddlewarePipeline;
  private readonly plugins: PluginRuntime;
  private readonly shutdownTimeoutMs: number;
  private state: BotKernelState = "created";
  private startedAt: Date | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly inFlightMessages = new Set<Promise<void>>();
  private readonly metrics = {
    received: 0,
    processed: 0,
    failed: 0,
    commandsHandled: 0
  };

  public constructor(options: BotKernelOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs <= 0
    ) {
      throw new Error("shutdown timeout must be a positive integer");
    }

    const messages: MessageSender = {
      send: (message) => this.adapter.send(message),
      reply: (message, content) =>
        this.adapter.send({
          conversationId: message.conversationId,
          scope: message.scope,
          content,
          replyTo: message.id
        })
    };

    this.events = new EventBus(options.logger);
    this.middleware = new MiddlewarePipeline(messages);
    const commandPrefix = options.commandPrefix ?? "/";
    this.commands = new CommandRouter(
      commandPrefix,
      messages,
      options.logger
    );
    this.navigation = new BotNavigationRegistry(commandPrefix);
    this.plugins = new PluginRuntime(
      this.events,
      this.commands,
      this.navigation,
      this.middleware,
      messages,
      new IntervalScheduler(options.logger),
      options.store ?? new MemoryStore(),
      new ServiceContainer(),
      options.logger
    );
  }

  public async load(plugin: BotPlugin): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`cannot load plugins while kernel is ${this.state}`);
    }
    await this.plugins.load(plugin);
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

    this.startPromise = this.startInternal();
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
    const startedAt = this.startedAt
      ? new Date(this.startedAt)
      : undefined;
    return {
      state: this.state,
      adapter: this.adapter.name,
      ...(startedAt ? { startedAt } : {}),
      uptimeMs: startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : 0,
      inFlightMessages: this.inFlightMessages.size,
      metrics: { ...this.metrics },
      plugins: this.plugins.snapshot()
    };
  }

  private async startInternal(): Promise<void> {
    this.state = "starting";
    try {
      await this.adapter.start((message) => this.handleIncoming(message));
      this.startedAt = new Date();
      this.state = "running";
      await this.events.emit("bot.ready", { adapter: this.adapter.name });
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
    if (this.state === "starting" && this.startPromise) {
      try {
        await this.adapter.stop();
      } catch (error) {
        errors.push(error);
        this.logger.error(
          { error },
          "adapter stop during startup failed"
        );
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
    const processing = this.processMessage(message);
    this.inFlightMessages.add(processing);
    try {
      await processing;
    } finally {
      this.inFlightMessages.delete(processing);
    }
  }

  private async processMessage(message: IncomingMessage): Promise<void> {
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

export type {
  BotAdapter,
  BotPlugin,
  IncomingMessage,
  KeyValueStore,
  Logger,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
export { MemoryStore } from "./memory-store.js";
