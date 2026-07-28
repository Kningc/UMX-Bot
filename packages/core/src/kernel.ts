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
import { PluginRuntime } from "./plugin-runtime.js";
import { IntervalScheduler } from "./scheduler.js";

export interface BotKernelOptions {
  adapter: BotAdapter;
  logger: Logger;
  commandPrefix?: string;
  store?: KeyValueStore;
}

export class BotKernel {
  private readonly adapter: BotAdapter;
  private readonly logger: Logger;
  private readonly events: EventBus;
  private readonly commands: CommandRouter;
  private readonly plugins: PluginRuntime;
  private started = false;

  public constructor(options: BotKernelOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;

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
    this.commands = new CommandRouter(
      options.commandPrefix ?? "/",
      messages,
      options.logger
    );
    this.plugins = new PluginRuntime(
      this.events,
      this.commands,
      messages,
      new IntervalScheduler(options.logger),
      options.store ?? new MemoryStore(),
      options.logger
    );
  }

  public async load(plugin: BotPlugin): Promise<void> {
    await this.plugins.load(plugin);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.adapter.start((message) => this.handleMessage(message));
    this.started = true;
    await this.events.emit("bot.ready", { adapter: this.adapter.name });
    this.logger.info({ adapter: this.adapter.name }, "bot started");
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.adapter.stop();
    await this.plugins.unloadAll();
    this.started = false;
    this.logger.info({}, "bot stopped");
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    await this.events.emit("message.created", message);
    await this.commands.handle(message);
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
