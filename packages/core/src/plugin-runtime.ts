import type {
  BotEvents,
  BotPlugin,
  Dispose,
  EventSubscriber,
  KeyValueStore,
  Logger,
  MessageSender,
  NavigationRegistry,
  PluginContext,
  PluginHelpSummary,
  PluginPermission,
  Scheduler,
  ServiceRegistry
} from "@qq-bot/plugin-sdk";
import {
  LEGACY_PLUGIN_API_VERSION,
  PermissionError,
  PLUGIN_PERMISSIONS,
  SUPPORTED_PLUGIN_API_VERSIONS
} from "@qq-bot/plugin-sdk";
import type { CommandRouter } from "./command-router.js";
import type { InteractionRouter } from "./interaction-router.js";
import type { MetricsRegistry } from "./metrics-registry.js";
import type { MiddlewarePipeline } from "./middleware-pipeline.js";
import type { BotNavigationRegistry } from "./navigation-registry.js";
import type { OutboundPipeline } from "./outbound-pipeline.js";
import type { NormalizedPluginDependency } from "./plugin-compatibility.js";
import {
  assertPluginVersion,
  normalizePluginDependency,
  satisfiesPluginVersion
} from "./plugin-compatibility.js";
import { prefixKeyValueStore } from "./prefixed-store.js";
import {
  PluginScopedStateRegistry,
  PluginSettingsRegistry
} from "./scoped-storage.js";
import type { SettingsCatalog } from "./settings-catalog.js";

interface LoadedPlugin {
  plugin: BotPlugin;
  permissions: ReadonlySet<PluginPermission> | undefined;
  disposers: Dispose[];
  controller: AbortController;
  loadedAt: Date;
}

/** Host-provided addition to every plugin's context, under `name`. */
export interface ContextExtension {
  name: string;
  create(info: {
    pluginName: string;
    signal: AbortSignal;
    logger: Logger;
    /** Undefined for an unrestricted (legacy) plugin. */
    permissions: ReadonlySet<PluginPermission> | undefined;
  }): { value: unknown; dispose?: Dispose };
}

export interface PluginRuntimeOptions {
  extensions?: readonly ContextExtension[];
  settingsCatalog: SettingsCatalog;
  metrics: MetricsRegistry;
  interactions: InteractionRouter;
  outbound: OutboundPipeline;
}

const RESERVED_CONTEXT_KEYS = new Set([
  "pluginName",
  "config",
  "signal",
  "events",
  "commands",
  "navigation",
  "middleware",
  "outbound",
  "interactions",
  "metrics",
  "messages",
  "scheduler",
  "store",
  "settings",
  "state",
  "services",
  "logger"
]);

const MESSAGING_REQUIREMENTS = new Set(["recall", "typing", "stream"]);

export interface PluginSnapshot {
  name: string;
  version: string;
  apiVersion: number;
  /** Undefined means the plugin runs unrestricted (legacy behaviour). */
  permissions?: PluginPermission[];
  dependencies: NormalizedPluginDependency[];
  loadedAt: Date;
}

export interface PluginLoadOptions {
  config?: Readonly<Record<string, unknown>>;
  /**
   * Powers granted by the deployment. Combined with the plugin's own
   * `permissions`: a plugin may not need more than is granted here.
   */
  permissions?: readonly PluginPermission[];
}

export class PluginRuntime {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly loading = new Map<string, AbortController>();

  public constructor(
    private readonly events: {
      forPlugin(plugin: string): EventSubscriber;
      emit<K extends keyof BotEvents>(
        event: K,
        payload: BotEvents[K]
      ): Promise<void>;
    },
    private readonly commands: CommandRouter,
    private readonly navigation: BotNavigationRegistry,
    private readonly middleware: MiddlewarePipeline,
    private readonly messages: MessageSender,
    private readonly scheduler: Scheduler,
    private readonly store: KeyValueStore,
    private readonly services: {
      forPlugin(plugin: string): ServiceRegistry;
    },
    private readonly logger: Logger,
    private readonly options: PluginRuntimeOptions
  ) {
    const seen = new Set<string>();
    for (const extension of options.extensions ?? []) {
      if (
        RESERVED_CONTEXT_KEYS.has(extension.name) ||
        seen.has(extension.name) ||
        !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(extension.name)
      ) {
        throw new Error(`invalid context extension name "${extension.name}"`);
      }
      seen.add(extension.name);
    }
  }

  public async load(
    plugin: BotPlugin,
    options: PluginLoadOptions = {}
  ): Promise<void> {
    this.validatePlugin(plugin);
    if (this.loaded.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already loaded`);
    }
    if (this.loading.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already loading`);
    }
    const dependencies = this.dependenciesOf(plugin);
    const missingDependencies = dependencies.filter(
      (dependency) => !dependency.optional && !this.loaded.has(dependency.name)
    );
    if (missingDependencies.length > 0) {
      throw new Error(
        `plugin "${plugin.name}" is missing dependencies: ${missingDependencies
          .map((dependency) => dependency.name)
          .join(", ")}`
      );
    }
    for (const dependency of dependencies) {
      const provider = this.loaded.get(dependency.name)?.plugin;
      if (
        provider &&
        !satisfiesPluginVersion(provider.version, dependency.version)
      ) {
        throw new Error(
          `plugin "${plugin.name}" requires "${dependency.name}" ${dependency.version}, but ${provider.version} is loaded`
        );
      }
    }

    const permissions = this.resolvePermissions(plugin, options.permissions);
    this.assertRequirements(plugin);

    const disposers: Dispose[] = [];
    const controller = new AbortController();
    const pluginLogger = this.logger.child({ plugin: plugin.name });
    const pluginEvents = this.events.forPlugin(plugin.name);
    const track = (dispose: Dispose): Dispose => {
      disposers.push(dispose);
      return dispose;
    };
    const pluginHelp = this.helpSummary(plugin);
    const commandRegistry = this.commands.forPlugin(pluginHelp);
    const navigationRegistry: NavigationRegistry =
      this.navigation.forPlugin(pluginHelp);
    const middlewareRegistry = this.middleware.forPlugin(plugin.name);
    const outboundRegistry = this.options.outbound.forPlugin(plugin.name);
    const serviceRegistry = this.services.forPlugin(plugin.name);
    const pluginStore: KeyValueStore = prefixKeyValueStore(
      this.store,
      plugin.name
    );

    const parsedConfig = plugin.configuration
      ? plugin.configuration.parse(structuredClone(options.config ?? {}))
      : (options.config ?? {});
    assertConfigurationObject(parsedConfig, plugin.name);
    const require = (permission: PluginPermission): void => {
      if (permissions && !permissions.has(permission)) {
        throw new PermissionError(plugin.name, permission);
      }
    };
    const guardedMessages = this.guardMessages(require);
    const context: PluginContext<object> = {
      pluginName: plugin.name,
      config: cloneAndFreezeConfig(parsedConfig),
      signal: controller.signal,
      events: {
        on: (event, handler, options) =>
          track(pluginEvents.on(event, handler, options)),
        emit: (event, payload) => {
          require("events.emit");
          if (!String(event).startsWith(`${plugin.name}.`)) {
            throw new Error(
              `plugin "${plugin.name}" can only emit events named "${plugin.name}.…", not "${String(event)}"`
            );
          }
          return this.events.emit(event, payload);
        }
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
        use: (handler, options) => {
          require("middleware");
          return track(middlewareRegistry.use(handler, options));
        }
      },
      outbound: {
        use: (hook, options) => {
          require("outbound");
          return track(outboundRegistry.use(hook, options));
        }
      },
      interactions: this.options.interactions.forPlugin(plugin.name, track),
      metrics: this.options.metrics.forPlugin(plugin.name, track),
      messages: guardedMessages,
      scheduler: {
        every: (name, intervalMs, task, options) => {
          require("scheduler");
          return track(
            this.scheduler.every(
              `${plugin.name}:${name}`,
              intervalMs,
              task,
              options
            )
          );
        },
        cron: (name, expression, task, options) => {
          require("scheduler");
          return track(
            this.scheduler.cron(
              `${plugin.name}:${name}`,
              expression,
              task,
              options
            )
          );
        },
        at: (name, when, task) => {
          require("scheduler");
          return track(this.scheduler.at(`${plugin.name}:${name}`, when, task));
        }
      },
      store: pluginStore,
      settings: new PluginSettingsRegistry(pluginStore, (defined) => {
        track(
          this.options.settingsCatalog.register({
            plugin: plugin.name,
            ...defined
          })
        );
      }),
      state: new PluginScopedStateRegistry(pluginStore),
      services: {
        provide: (token, service) =>
          track(serviceRegistry.provide(token, service)),
        get: (token) => serviceRegistry.get(token),
        has: (token) => serviceRegistry.has(token)
      },
      logger: pluginLogger
    };

    for (const extension of this.options.extensions ?? []) {
      const created = extension.create({
        pluginName: plugin.name,
        signal: controller.signal,
        logger: pluginLogger,
        permissions
      });
      (context as unknown as Record<string, unknown>)[extension.name] =
        created.value;
      if (created.dispose) {
        disposers.push(created.dispose);
      }
    }

    this.loading.set(plugin.name, controller);
    try {
      const teardown = await plugin.setup(context);
      if (controller.signal.aborted) {
        throw new Error(`plugin "${plugin.name}" loading was cancelled`);
      }
      if (teardown !== undefined && typeof teardown !== "function") {
        throw new TypeError(
          `plugin "${plugin.name}" setup must return a cleanup function or undefined`
        );
      }
      if (teardown !== undefined) {
        disposers.push(teardown);
      }
      this.navigation.validatePlugin(plugin.name, this.commands.list());
      this.loaded.set(plugin.name, {
        plugin,
        permissions,
        disposers,
        controller,
        loadedAt: new Date()
      });
      pluginLogger.info({ version: plugin.version }, "plugin loaded");
    } catch (error) {
      controller.abort();
      pluginLogger.error({ error }, "plugin setup failed");
      await this.disposeAll(disposers, pluginLogger);
      throw error;
    } finally {
      this.loading.delete(plugin.name);
    }
  }

  public cancelLoading(): void {
    for (const controller of this.loading.values()) {
      controller.abort();
    }
  }

  public async unload(name: string): Promise<boolean> {
    const loaded = this.loaded.get(name);
    if (!loaded) {
      return false;
    }
    const dependents = [...this.loaded.values()]
      .filter((candidate) =>
        this.dependenciesOf(candidate.plugin).some(
          (dependency) => dependency.name === name
        )
      )
      .map((candidate) => candidate.plugin.name);
    if (dependents.length > 0) {
      throw new Error(
        `plugin "${name}" is required by: ${dependents.join(", ")}`
      );
    }

    this.loaded.delete(name);
    loaded.controller.abort();
    await this.disposeAll(
      loaded.disposers,
      this.logger.child({ plugin: name })
    );
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
      apiVersion: loaded.plugin.apiVersion ?? LEGACY_PLUGIN_API_VERSION,
      ...(loaded.permissions
        ? { permissions: [...loaded.permissions].sort() }
        : {}),
      dependencies: this.dependenciesOf(loaded.plugin).map((dependency) => ({
        ...dependency
      })),
      loadedAt: new Date(loaded.loadedAt)
    }));
  }

  /** Combines what the plugin declares with what the deployment grants. */
  private resolvePermissions(
    plugin: BotPlugin,
    granted: readonly PluginPermission[] | undefined
  ): ReadonlySet<PluginPermission> | undefined {
    for (const permission of [
      ...(plugin.permissions ?? []),
      ...(granted ?? [])
    ]) {
      if (!(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)) {
        throw new Error(
          `plugin "${plugin.name}" uses unknown permission "${permission}"`
        );
      }
    }
    if (plugin.permissions && granted) {
      const missing = plugin.permissions.filter(
        (permission) => !granted.includes(permission)
      );
      if (missing.length > 0) {
        throw new Error(
          `plugin "${plugin.name}" needs permissions the manifest does not grant: ${missing.join(", ")}`
        );
      }
    }
    const effective = granted ?? plugin.permissions;
    return effective ? new Set(effective) : undefined;
  }

  private assertRequirements(plugin: BotPlugin): void {
    const extensions = new Set(
      (this.options.extensions ?? []).map((extension) => extension.name)
    );
    for (const requirement of plugin.requires ?? []) {
      const [area, capability] = requirement.split(".");
      const available =
        area === "messages" && capability !== undefined
          ? MESSAGING_REQUIREMENTS.has(capability) &&
            this.messages.supports(capability as "recall" | "typing" | "stream")
          : extensions.has(requirement);
      if (!available) {
        throw new Error(
          `plugin "${plugin.name}" requires "${requirement}", which this host does not provide`
        );
      }
    }
  }

  /** A restricted plugin cannot use active delivery or message streams. */
  private guardMessages(
    require: (permission: PluginPermission) => void
  ): MessageSender {
    const messages = this.messages;
    return {
      send: (message) => {
        if (message.delivery.type !== "passive") {
          require("messages.active");
        }
        return messages.send(message);
      },
      reply: (message, content) => messages.reply(message, content),
      recall: (message) => messages.recall(message),
      setTyping: (conversation, seconds, target) =>
        messages.setTyping(conversation, seconds, target),
      openStream: (options) => {
        if (options.delivery.type !== "passive") {
          require("messages.active");
        }
        return messages.openStream(options);
      },
      supports: (capability) => messages.supports(capability)
    };
  }

  private async disposeAll(
    disposers: Dispose[],
    logger: Logger
  ): Promise<void> {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch (error) {
        logger.error({ error }, "plugin cleanup failed");
      }
    }
  }

  private validatePlugin(plugin: BotPlugin): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(plugin.name)) {
      throw new Error(
        `invalid plugin name "${plugin.name}"; use lowercase letters, numbers, dot, underscore or dash`
      );
    }
    assertPluginVersion(plugin.version, `plugin "${plugin.name}" version`);
    const apiVersion = plugin.apiVersion ?? LEGACY_PLUGIN_API_VERSION;
    if (
      !SUPPORTED_PLUGIN_API_VERSIONS.some(
        (supported) => supported === apiVersion
      )
    ) {
      throw new Error(
        `plugin "${plugin.name}" uses unsupported plugin API version ${String(apiVersion)}; runtime supports ${SUPPORTED_PLUGIN_API_VERSIONS.join(", ")}`
      );
    }
    const dependencies = this.dependenciesOf(plugin);
    if (dependencies.some((dependency) => dependency.name === plugin.name)) {
      throw new Error(`plugin "${plugin.name}" cannot depend on itself`);
    }
    if (
      new Set(dependencies.map((dependency) => dependency.name)).size !==
      dependencies.length
    ) {
      throw new Error(
        `plugin "${plugin.name}" contains duplicate dependencies`
      );
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
      throw new Error(
        `plugin "${plugin.name}" help description cannot be empty`
      );
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

  private dependenciesOf(plugin: BotPlugin): NormalizedPluginDependency[] {
    return (plugin.dependencies ?? []).map((dependency) =>
      normalizePluginDependency(dependency, `plugin "${plugin.name}"`)
    );
  }
}

function cloneAndFreezeConfig<TConfig extends object>(
  config: TConfig
): Readonly<TConfig> {
  const cloned = structuredClone(config);
  return deepFreeze(cloned);
}

function assertConfigurationObject(value: object, pluginName: string): void {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `plugin "${pluginName}" configuration must resolve to a plain object`
    );
  }
  assertConfigurationValue(value, pluginName, "config", new WeakSet());
}

function assertConfigurationValue(
  value: unknown,
  pluginName: string,
  path: string,
  seen: WeakSet<object>
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value === undefined
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(
      `plugin "${pluginName}" configuration value "${path}" must be JSON-like`
    );
  }
  if (seen.has(value)) {
    throw new TypeError(
      `plugin "${pluginName}" configuration value "${path}" cannot be circular`
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertConfigurationValue(item, pluginName, `${path}[${index}]`, seen);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new TypeError(
        `plugin "${pluginName}" configuration value "${path}" must be JSON-like`
      );
    }
    for (const [key, nested] of Object.entries(value)) {
      assertConfigurationValue(nested, pluginName, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
