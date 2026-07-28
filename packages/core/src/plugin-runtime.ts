import type {
  BotPlugin,
  Dispose,
  EventSubscriber,
  KeyValueStore,
  Logger,
  MessageSender,
  PluginContext,
  Scheduler
} from "@qq-bot/plugin-sdk";
import type { CommandRouter } from "./command-router.js";

interface LoadedPlugin {
  plugin: BotPlugin;
  disposers: Dispose[];
}

export class PluginRuntime {
  private readonly loaded = new Map<string, LoadedPlugin>();

  public constructor(
    private readonly events: EventSubscriber,
    private readonly commands: CommandRouter,
    private readonly messages: MessageSender,
    private readonly scheduler: Scheduler,
    private readonly store: KeyValueStore,
    private readonly logger: Logger
  ) {}

  public async load(plugin: BotPlugin): Promise<void> {
    if (this.loaded.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already loaded`);
    }

    const disposers: Dispose[] = [];
    const pluginLogger = this.logger.child({ plugin: plugin.name });
    const track = (dispose: Dispose): Dispose => {
      disposers.push(dispose);
      return dispose;
    };
    const commandRegistry = this.commands.forPlugin(plugin.name);

    const context: PluginContext = {
      pluginName: plugin.name,
      events: {
        on: (event, handler) => track(this.events.on(event, handler))
      },
      commands: {
        register: (command) => track(commandRegistry.register(command)),
        list: () => commandRegistry.list()
      },
      messages: this.messages,
      scheduler: {
        every: (name, intervalMs, task) =>
          track(
            this.scheduler.every(`${plugin.name}:${name}`, intervalMs, task)
          )
      },
      store: {
        get: (key) => this.store.get(`${plugin.name}:${key}`),
        set: (key, value) => this.store.set(`${plugin.name}:${key}`, value),
        delete: (key) => this.store.delete(`${plugin.name}:${key}`)
      },
      logger: pluginLogger
    };

    try {
      const teardown = await plugin.setup(context);
      if (teardown) {
        disposers.push(teardown);
      }
      this.loaded.set(plugin.name, { plugin, disposers });
      pluginLogger.info({ version: plugin.version }, "plugin loaded");
    } catch (error) {
      await this.disposeAll(disposers);
      throw error;
    }
  }

  public async unload(name: string): Promise<boolean> {
    const loaded = this.loaded.get(name);
    if (!loaded) {
      return false;
    }

    this.loaded.delete(name);
    await this.disposeAll(loaded.disposers);
    this.logger.info({ plugin: name }, "plugin unloaded");
    return true;
  }

  public async unloadAll(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse()) {
      await this.unload(name);
    }
  }

  private async disposeAll(disposers: Dispose[]): Promise<void> {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.logger.error({ error }, "plugin cleanup failed");
      }
    }
  }
}
