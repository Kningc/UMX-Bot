import type {
  BotPlugin,
  Dispose,
  EventSubscriber,
  KeyValueStore,
  Logger,
  MessageSender,
  PluginContext,
  PluginHelpSummary,
  NavigationRegistry,
  ServiceRegistry,
  Scheduler
} from "@qq-bot/plugin-sdk";
import type { CommandRouter } from "./command-router.js";
import type { MiddlewarePipeline } from "./middleware-pipeline.js";
import type { BotNavigationRegistry } from "./navigation-registry.js";
import {
  PluginScopedStateRegistry,
  PluginSettingsRegistry
} from "./scoped-storage.js";

interface LoadedPlugin {
  plugin: BotPlugin;
  disposers: Dispose[];
  controller: AbortController;
  loadedAt: Date;
}

export interface PluginSnapshot {
  name: string;
  version: string;
  dependencies: string[];
  loadedAt: Date;
}

export class PluginRuntime {
  private readonly loaded = new Map<string, LoadedPlugin>();

  public constructor(
    private readonly events: EventSubscriber,
    private readonly commands: CommandRouter,
    private readonly navigation: BotNavigationRegistry,
    private readonly middleware: MiddlewarePipeline,
    private readonly messages: MessageSender,
    private readonly scheduler: Scheduler,
    private readonly store: KeyValueStore,
    private readonly services: {
      forPlugin(plugin: string): ServiceRegistry;
    },
    private readonly logger: Logger
  ) {}

  public async load(plugin: BotPlugin): Promise<void> {
    this.validatePlugin(plugin);
    if (this.loaded.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already loaded`);
    }
    const missingDependencies = (plugin.dependencies ?? []).filter(
      (dependency) => !this.loaded.has(dependency)
    );
    if (missingDependencies.length > 0) {
      throw new Error(
        `plugin "${plugin.name}" is missing dependencies: ${missingDependencies.join(", ")}`
      );
    }

    const disposers: Dispose[] = [];
    const controller = new AbortController();
    const pluginLogger = this.logger.child({ plugin: plugin.name });
    const track = (dispose: Dispose): Dispose => {
      disposers.push(dispose);
      return dispose;
    };
    const pluginHelp = this.helpSummary(plugin);
    const commandRegistry = this.commands.forPlugin(pluginHelp);
    const navigationRegistry: NavigationRegistry =
      this.navigation.forPlugin(pluginHelp);
    const middlewareRegistry = this.middleware.forPlugin(plugin.name);
    const serviceRegistry = this.services.forPlugin(plugin.name);
    const pluginStore: KeyValueStore = {
      get: (key) => this.store.get(`${plugin.name}:${key}`),
      set: (key, value) => this.store.set(`${plugin.name}:${key}`, value),
      delete: (key) => this.store.delete(`${plugin.name}:${key}`),
      update: (key, updater) =>
        this.store.update(`${plugin.name}:${key}`, updater)
    };

    const context: PluginContext = {
      pluginName: plugin.name,
      signal: controller.signal,
      events: {
        on: (event, handler, options) =>
          track(this.events.on(event, handler, options))
      },
      commands: {
        register: (command) => track(commandRegistry.register(command)),
        list: () => commandRegistry.list(),
        format: (name, args) => commandRegistry.format(name, args)
      },
      navigation: {
        register: (page) => track(navigationRegistry.register(page)),
        list: () => navigationRegistry.list()
      },
      middleware: {
        use: (handler, options) =>
          track(middlewareRegistry.use(handler, options))
      },
      messages: this.messages,
      scheduler: {
        every: (name, intervalMs, task, options) =>
          track(
            this.scheduler.every(
              `${plugin.name}:${name}`,
              intervalMs,
              task,
              options
            )
          )
      },
      store: pluginStore,
      settings: new PluginSettingsRegistry(pluginStore),
      state: new PluginScopedStateRegistry(pluginStore),
      services: {
        provide: (token, service) =>
          track(serviceRegistry.provide(token, service)),
        get: (token) => serviceRegistry.get(token),
        has: (token) => serviceRegistry.has(token)
      },
      logger: pluginLogger
    };

    try {
      const teardown = await plugin.setup(context);
      if (teardown) {
        disposers.push(teardown);
      }
      this.navigation.validatePlugin(plugin.name, this.commands.list());
      this.loaded.set(plugin.name, {
        plugin,
        disposers,
        controller,
        loadedAt: new Date()
      });
      pluginLogger.info({ version: plugin.version }, "plugin loaded");
    } catch (error) {
      controller.abort();
      await this.disposeAll(disposers);
      throw error;
    }
  }

  public async unload(name: string): Promise<boolean> {
    const loaded = this.loaded.get(name);
    if (!loaded) {
      return false;
    }
    const dependents = [...this.loaded.values()]
      .filter((candidate) =>
        candidate.plugin.dependencies?.includes(name)
      )
      .map((candidate) => candidate.plugin.name);
    if (dependents.length > 0) {
      throw new Error(
        `plugin "${name}" is required by: ${dependents.join(", ")}`
      );
    }

    this.loaded.delete(name);
    loaded.controller.abort();
    await this.disposeAll(loaded.disposers);
    this.logger.info({ plugin: name }, "plugin unloaded");
    return true;
  }

  public async unloadAll(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse()) {
      await this.unload(name);
    }
  }

  public snapshot(): PluginSnapshot[] {
    return [...this.loaded.values()].map((loaded) => ({
      name: loaded.plugin.name,
      version: loaded.plugin.version,
      dependencies: [...(loaded.plugin.dependencies ?? [])],
      loadedAt: new Date(loaded.loadedAt)
    }));
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

  private validatePlugin(plugin: BotPlugin): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(plugin.name)) {
      throw new Error(
        `invalid plugin name "${plugin.name}"; use lowercase letters, numbers, dot, underscore or dash`
      );
    }
    if (plugin.version.trim().length === 0) {
      throw new Error(`plugin "${plugin.name}" must declare a version`);
    }
    if (plugin.dependencies?.includes(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" cannot depend on itself`);
    }
    if (
      plugin.dependencies &&
      new Set(plugin.dependencies).size !== plugin.dependencies.length
    ) {
      throw new Error(`plugin "${plugin.name}" contains duplicate dependencies`);
    }
    if (
      plugin.help?.title !== undefined &&
      plugin.help.title.trim().length === 0
    ) {
      throw new Error(`plugin "${plugin.name}" help title cannot be empty`);
    }
    if (
      plugin.help?.description !== undefined &&
      plugin.help.description.trim().length === 0
    ) {
      throw new Error(`plugin "${plugin.name}" help description cannot be empty`);
    }
    if (
      plugin.help?.order !== undefined &&
      !Number.isSafeInteger(plugin.help.order)
    ) {
      throw new Error(`plugin "${plugin.name}" help order must be an integer`);
    }
  }

  private helpSummary(plugin: BotPlugin): PluginHelpSummary {
    const description = plugin.help?.description ?? plugin.description;
    return {
      name: plugin.name,
      title: plugin.help?.title?.trim() || plugin.name,
      ...(description?.trim()
        ? {
            description: description.trim()
          }
        : {}),
      order: plugin.help?.order ?? 0,
      listed: plugin.help?.listed ?? true
    };
  }
}
