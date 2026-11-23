import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BotKernel, PluginLoadOptions } from "@umx-bot/core";
import {
  assertPluginVersion,
  normalizePluginDependency,
  satisfiesPluginVersion
} from "@umx-bot/core";
import type { BotPlugin, Logger, PluginPermission } from "@umx-bot/plugin-sdk";
import {
  LEGACY_PLUGIN_API_VERSION,
  PLUGIN_PERMISSIONS,
  SUPPORTED_PLUGIN_API_VERSIONS
} from "@umx-bot/plugin-sdk";
import {
  connectRemotePlugin,
  type RemoteBotPlugin,
  type RemotePluginSpec
} from "./remote-plugin.js";

export interface PluginManifestEntry {
  specifier: string;
  enabled?: boolean;
  config?: Readonly<Record<string, unknown>>;
  secrets?: Readonly<Record<string, string>>;
  /**
   * Powers granted to this plugin. When present it restricts the plugin to
   * exactly these (and a plugin that declares more fails to load); when absent
   * the plugin gets whatever it declares, or is unrestricted if it declares
   * nothing.
   */
  permissions?: PluginPermission[];
  /**
   * Runs the plugin in a child process speaking the stdio protocol of
   * docs/remote-plugins.md instead of importing `specifier` as a module. The
   * specifier is then just an identifier (convention: `remote:<name>`).
   * A remote plugin is always restricted: `permissions` (or, when absent, what
   * it declares in its handshake) is all it can use.
   */
  remote?: RemotePluginSpec;
}

export interface PluginManifest {
  schemaVersion: 1;
  plugins: PluginManifestEntry[];
}

interface ResolvedPlugin {
  plugin: BotPlugin;
  options: PluginLoadOptions;
  specifier: string;
}

const defaultManifest: PluginManifest = {
  schemaVersion: 1,
  plugins: [
    { specifier: "@umx-bot/plugin-help" },
    { specifier: "@umx-bot/plugin-ping" },
    { specifier: "@umx-bot/plugin-minecraft-status" }
  ]
};

export interface PluginManagerOptions {
  manifestPath?: string;
  environment?: NodeJS.ProcessEnv;
  logger: Logger;
  /**
   * How many code-reloading `reload` calls to allow per process. Node cannot
   * free an imported ES module, so each one leaks the previous build until the
   * process restarts. Defaults to 20.
   */
  maxHotReloads?: number;
}

export interface PluginStatus {
  name: string;
  specifier: string;
  version?: string;
  /** Whether the manifest entry is enabled. */
  configured: boolean;
  /** Whether it is loaded in this process right now. */
  loaded: boolean;
}

/**
 * Owns the plugin manifest for a running process.
 *
 * Kept separate from the kernel because the manifest is a deployment
 * boundary: the kernel knows how to load a plugin object, while resolving a
 * specifier, injecting secrets and ordering dependencies is the application's
 * job.
 */
export class PluginManager {
  private readonly manifestPath: string | undefined;
  private readonly baseDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  /** Specifier per loaded plugin name, for `reload` and status reporting. */
  private readonly specifiers = new Map<string, string>();
  private readonly maxHotReloads: number;
  private hotReloads = 0;

  public constructor(options: PluginManagerOptions) {
    this.maxHotReloads = options.maxHotReloads ?? 20;
    this.manifestPath = options.manifestPath
      ? resolve(options.manifestPath)
      : undefined;
    this.baseDirectory = this.manifestPath
      ? dirname(this.manifestPath)
      : process.cwd();
    this.environment = options.environment ?? process.env;
    this.logger = options.logger;
  }

  public async loadAll(bot: BotKernel): Promise<void> {
    const plugins = await this.resolveManifest();
    let ordered: ResolvedPlugin[];
    try {
      ordered = sortPluginsByDependencies(plugins);
    } catch (error) {
      await closeRemotePlugins(plugins);
      throw error;
    }
    for (const [index, resolvedPlugin] of ordered.entries()) {
      try {
        await bot.load(resolvedPlugin.plugin, resolvedPlugin.options);
      } catch (error) {
        // Children of this and every not-yet-loaded plugin are still running.
        await closeRemotePlugins(ordered.slice(index));
        throw error;
      }
      this.specifiers.set(resolvedPlugin.plugin.name, resolvedPlugin.specifier);
      this.logger.info(
        {
          plugin: resolvedPlugin.plugin.name,
          version: resolvedPlugin.plugin.version,
          specifier: resolvedPlugin.specifier
        },
        "configured plugin loaded"
      );
    }
  }

  /** Manifest entries and loaded plugins, merged into one view. */
  public async list(bot: BotKernel): Promise<PluginStatus[]> {
    const loaded = new Map(
      bot.getHealth().plugins.map((plugin) => [plugin.name, plugin])
    );
    const statuses = new Map<string, PluginStatus>();
    for (const entry of await this.readManifestEntries()) {
      // The name is only known after the module is imported, so a disabled or
      // broken entry is reported under its specifier.
      const name =
        [...this.specifiers.entries()].find(
          ([, specifier]) => specifier === entry.specifier
        )?.[0] ??
        entry.remote?.name ??
        entry.specifier;
      statuses.set(name, {
        name,
        specifier: entry.specifier,
        ...(loaded.get(name)?.version
          ? { version: loaded.get(name)?.version as string }
          : {}),
        configured: entry.enabled !== false,
        loaded: loaded.has(name)
      });
    }
    for (const [name, plugin] of loaded) {
      if (statuses.has(name)) {
        continue;
      }
      statuses.set(name, {
        name,
        specifier: this.specifiers.get(name) ?? "(not in manifest)",
        version: plugin.version,
        configured: false,
        loaded: true
      });
    }
    return [...statuses.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  public async disable(bot: BotKernel, name: string): Promise<boolean> {
    const unloaded = await bot.unload(name);
    if (unloaded) {
      this.logger.warn({ plugin: name, audit: "plugin" }, "plugin disabled");
    }
    return unloaded;
  }

  /**
   * Loads a manifest entry into the running bot.
   *
   * The manifest is re-read, so configuration and secret changes take effect.
   * Code changes only take effect for a path specifier: Node caches an
   * imported module, and only a file URL can be cache-busted.
   */
  public async enable(bot: BotKernel, name: string): Promise<boolean> {
    const loadedNames = new Set(
      bot.getHealth().plugins.map((plugin) => plugin.name)
    );
    if (loadedNames.has(name)) {
      return false;
    }
    const target = await this.resolveTarget(name);
    try {
      await bot.load(target.plugin, target.options);
    } catch (error) {
      await closeRemotePlugins([target]);
      throw error;
    }
    this.specifiers.set(target.plugin.name, target.specifier);
    this.logger.warn(
      { plugin: target.plugin.name, audit: "plugin" },
      "plugin enabled at runtime"
    );
    return true;
  }

  public async reload(bot: BotKernel, name: string): Promise<void> {
    // Resolve the replacement *before* unloading anything: a typo in the
    // manifest or a syntax error in the new build must leave the running
    // plugin alone rather than take it down.
    const bustCache = this.reloadPicksUpCode(name);
    if (bustCache && this.hotReloads >= this.maxHotReloads) {
      throw new Error(
        `已热重载 ${this.hotReloads} 次，达到上限：Node 不会释放旧模块，继续会持续占用内存。请重启进程。`
      );
    }
    const target = await this.resolveTarget(name, { bustCache });
    if (bustCache) {
      this.hotReloads += 1;
      if (this.hotReloads === Math.ceil(this.maxHotReloads * 0.75)) {
        this.logger.warn(
          { hotReloads: this.hotReloads, max: this.maxHotReloads },
          "plugin hot reloads are close to the limit; restart soon"
        );
      }
    }
    try {
      await bot.unload(name);
    } catch (error) {
      await closeRemotePlugins([target]);
      throw error;
    }
    try {
      await bot.load(target.plugin, target.options);
    } catch (error) {
      await closeRemotePlugins([target]);
      throw new Error(
        `reload of "${name}" failed after it was unloaded, so it is not running: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    this.specifiers.set(target.plugin.name, target.specifier);
    this.logger.warn(
      { plugin: target.plugin.name, audit: "plugin" },
      "plugin reloaded at runtime"
    );
  }

  /**
   * True when `reload` also picks up code changes.
   *
   * Only a path specifier becomes a file URL, which can be cache-busted with
   * a query string; Node reuses the cached module for a bare package name.
   */
  public reloadPicksUpCode(name: string): boolean {
    const specifier = this.specifiers.get(name);
    return (
      specifier !== undefined &&
      (specifier.startsWith(".") || isAbsolute(specifier))
    );
  }

  private async readManifestEntries(): Promise<PluginManifestEntry[]> {
    const manifest = this.manifestPath
      ? await readManifest(this.manifestPath)
      : defaultManifest;
    return manifest.plugins;
  }

  private async resolveManifest(): Promise<ResolvedPlugin[]> {
    const manifest = this.manifestPath
      ? await readManifest(this.manifestPath)
      : defaultManifest;
    return resolvePlugins(manifest, this.baseDirectory, this.environment, {
      logger: this.logger
    });
  }

  /** Resolves one manifest entry by plugin name or specifier. */
  private async resolveTarget(
    name: string,
    options: { bustCache?: boolean } = {}
  ): Promise<ResolvedPlugin> {
    const manifest = this.manifestPath
      ? await readManifest(this.manifestPath)
      : defaultManifest;
    // Look at entries that already identify themselves first, so finding a
    // plugin by name does not have to import unrelated disabled modules.
    const known = this.specifiers.get(name);
    const direct = manifest.plugins.filter(
      (entry) =>
        entry.specifier === name ||
        entry.specifier === known ||
        entry.remote?.name === name
    );
    const [resolved] = await resolvePlugins(
      { ...manifest, plugins: direct.length > 0 ? direct : manifest.plugins },
      this.baseDirectory,
      this.environment,
      {
        target: name,
        bustCache: options.bustCache ?? false,
        logger: this.logger
      }
    );
    if (!resolved) {
      throw new Error(`no manifest entry resolves to plugin "${name}"`);
    }
    return resolved;
  }
}

export async function loadConfiguredPlugins(
  bot: BotKernel,
  options: PluginManagerOptions
): Promise<PluginManager> {
  const manager = new PluginManager(options);
  await manager.loadAll(bot);
  return manager;
}

async function readManifest(path: string): Promise<PluginManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read plugin manifest "${path}"`, {
      cause: error
    });
  }
  assertManifest(parsed, path);
  return parsed;
}

async function resolvePlugins(
  manifest: PluginManifest,
  baseDirectory: string,
  environment: NodeJS.ProcessEnv,
  options: {
    /**
     * Resolve exactly one entry, found by plugin name or specifier, whether or
     * not the manifest enables it. Everything else is left untouched: not
     * imported where avoidable, and never has its secrets resolved. Without
     * this, one disabled entry that needs an unset environment variable would
     * block enabling or reloading every other plugin.
     */
    target?: string;
    bustCache?: boolean;
    logger?: Logger;
  } = {}
): Promise<ResolvedPlugin[]> {
  const resolved: ResolvedPlugin[] = [];
  try {
    await resolveInto(resolved, manifest, baseDirectory, environment, options);
  } catch (error) {
    // Do not leave already-started child processes behind.
    await closeRemotePlugins(resolved);
    throw error;
  }
  return resolved;
}

async function resolveInto(
  resolved: ResolvedPlugin[],
  manifest: PluginManifest,
  baseDirectory: string,
  environment: NodeJS.ProcessEnv,
  options: {
    target?: string;
    bustCache?: boolean;
    logger?: Logger;
  }
): Promise<void> {
  const names = new Set<string>();

  for (const entry of manifest.plugins) {
    if (options.target === undefined && entry.enabled === false) {
      continue;
    }
    if (entry.remote) {
      if (
        options.target !== undefined &&
        entry.specifier !== options.target &&
        entry.remote.name !== options.target
      ) {
        // Without an expected `remote.name` the plugin name is only known
        // after spawning the child, so such entries are never probed by name.
        continue;
      }
      const remote = await connectRemoteEntry(
        entry,
        entry.remote,
        baseDirectory,
        options.logger,
        environment
      );
      resolved.push({
        plugin: remote,
        options: {
          config: resolveConfig(entry, environment),
          ...(entry.permissions ? { permissions: entry.permissions } : {})
        },
        specifier: entry.specifier
      });
      assertResolved(remote, names);
      if (options.target !== undefined) {
        break;
      }
      continue;
    }
    const specifier = resolveSpecifier(entry.specifier, baseDirectory);
    if (
      specifier !== entry.specifier &&
      entry.specifier.startsWith(LEGACY_SCOPE)
    ) {
      options.logger?.warn(
        { specifier: entry.specifier, resolved: specifier },
        "plugin specifier uses the retired @qq-bot scope; update plugins.json"
      );
    }
    const importTarget =
      options.bustCache && specifier.startsWith("file:")
        ? `${specifier}?reload=${Date.now()}`
        : specifier;
    const isDirectMatch = entry.specifier === options.target;
    let imported: Record<string, unknown>;
    try {
      imported = (await import(importTarget)) as Record<string, unknown>;
    } catch (error) {
      if (options.target !== undefined && !isDirectMatch) {
        // Probing other entries to find a plugin by name: a broken or missing
        // module there is not this operation's problem.
        continue;
      }
      throw new Error(`failed to import plugin "${entry.specifier}"`, {
        cause: error
      });
    }
    const plugin = imported.default;
    if (
      options.target !== undefined &&
      !isDirectMatch &&
      (typeof plugin !== "object" ||
        plugin === null ||
        (plugin as { name?: unknown }).name !== options.target)
    ) {
      continue;
    }
    assertPluginExport(plugin, entry.specifier);
    assertResolved(plugin, names);
    resolved.push({
      plugin,
      options: {
        config: resolveConfig(entry, environment),
        ...(entry.permissions ? { permissions: entry.permissions } : {})
      },
      specifier: entry.specifier
    });
    if (options.target !== undefined) {
      break;
    }
  }
}

function assertResolved(plugin: BotPlugin, names: Set<string>): void {
  assertPluginVersion(plugin.version, `plugin "${plugin.name}" version`);
  const apiVersion = plugin.apiVersion ?? LEGACY_PLUGIN_API_VERSION;
  if (
    !SUPPORTED_PLUGIN_API_VERSIONS.some((supported) => supported === apiVersion)
  ) {
    throw new Error(
      `plugin "${plugin.name}" uses unsupported plugin API version ${String(apiVersion)}`
    );
  }
  if (names.has(plugin.name)) {
    throw new Error(
      `plugin manifest resolves duplicate plugin name "${plugin.name}"`
    );
  }
  names.add(plugin.name);
}

async function connectRemoteEntry(
  entry: PluginManifestEntry,
  remote: RemotePluginSpec,
  baseDirectory: string,
  logger: Logger | undefined,
  environment: NodeJS.ProcessEnv
): Promise<RemoteBotPlugin> {
  if (!logger) {
    throw new Error("a logger is required to start a remote plugin");
  }
  try {
    return await connectRemotePlugin(
      { ...remote, cwd: resolve(baseDirectory, remote.cwd ?? ".") },
      { logger: logger.child({ specifier: entry.specifier }), environment }
    );
  } catch (error) {
    throw new Error(`failed to start remote plugin "${entry.specifier}"`, {
      cause: error
    });
  }
}

/** Kills the child processes of resolved remote plugins; ignores the rest. */
async function closeRemotePlugins(
  plugins: readonly { plugin: BotPlugin }[]
): Promise<void> {
  await Promise.all(
    plugins.map(async ({ plugin }) => {
      if ("close" in plugin && typeof plugin.close === "function") {
        await (plugin as RemoteBotPlugin).close();
      }
    })
  );
}

function resolveConfig(
  entry: PluginManifestEntry,
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, unknown>> {
  const config = structuredClone(entry.config ?? {}) as Record<string, unknown>;
  for (const [key, variable] of Object.entries(entry.secrets ?? {})) {
    const value = environment[variable];
    if (value === undefined) {
      throw new Error(
        `plugin "${entry.specifier}" requires environment variable "${variable}" for config key "${key}"`
      );
    }
    setConfigPath(config, key, value);
  }
  return config;
}

function setConfigPath(
  config: Record<string, unknown>,
  path: string,
  value: string
): void {
  const segments = path.split(".");
  let target = config;
  for (const segment of segments.slice(0, -1)) {
    const current = target[segment];
    if (current === undefined) {
      const nested: Record<string, unknown> = {};
      target[segment] = nested;
      target = nested;
      continue;
    }
    if (!isRecord(current)) {
      throw new Error(`plugin secret path "${path}" conflicts with config`);
    }
    target = current;
  }
  target[segments.at(-1)!] = value;
}

function sortPluginsByDependencies(
  plugins: ResolvedPlugin[]
): ResolvedPlugin[] {
  const byName = new Map(
    plugins.map((plugin) => [plugin.plugin.name, plugin] as const)
  );
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const sorted: ResolvedPlugin[] = [];

  const visit = (resolvedPlugin: ResolvedPlugin, trail: string[]): void => {
    const name = resolvedPlugin.plugin.name;
    if (permanent.has(name)) {
      return;
    }
    if (temporary.has(name)) {
      throw new Error(
        `plugin dependency cycle detected: ${[...trail, name].join(" -> ")}`
      );
    }
    temporary.add(name);
    for (const rawDependency of resolvedPlugin.plugin.dependencies ?? []) {
      const dependency = normalizePluginDependency(
        rawDependency,
        `plugin "${name}"`
      );
      const provider = byName.get(dependency.name);
      if (!provider) {
        if (dependency.optional) {
          continue;
        }
        throw new Error(
          `plugin "${name}" is missing dependency "${dependency.name}" in the manifest`
        );
      }
      if (
        !satisfiesPluginVersion(provider.plugin.version, dependency.version)
      ) {
        throw new Error(
          `plugin "${name}" requires "${dependency.name}" ${dependency.version}, but the manifest provides ${provider.plugin.version}`
        );
      }
      visit(provider, [...trail, name]);
    }
    temporary.delete(name);
    permanent.add(name);
    sorted.push(resolvedPlugin);
  };

  for (const plugin of plugins) {
    visit(plugin, []);
  }
  return sorted;
}

/**
 * The packages were published as @qq-bot/* before the scope moved to
 * @umx-bot/*. Manifests written for the old name keep working for the
 * packages this workspace ships; anything else under @qq-bot is left alone.
 */
const LEGACY_SCOPE = "@qq-bot/";
const CURRENT_SCOPE = "@umx-bot/";
const RENAMED_PACKAGES = new Set([
  "plugin-help",
  "plugin-ping",
  "plugin-minecraft-status",
  "plugin-sdk",
  "plugin-sdk-qq",
  "core",
  "plugin-testkit"
]);

function resolveSpecifier(specifier: string, baseDirectory: string): string {
  if (specifier.startsWith(LEGACY_SCOPE)) {
    const rest = specifier.slice(LEGACY_SCOPE.length);
    const packageName = rest.split("/")[0] ?? "";
    if (RENAMED_PACKAGES.has(packageName)) {
      return `${CURRENT_SCOPE}${rest}`;
    }
  }
  if (specifier.startsWith(".")) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  if (isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}

function assertManifest(
  value: unknown,
  path: string
): asserts value is PluginManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.plugins)
  ) {
    throw new Error(
      `plugin manifest "${path}" must contain schemaVersion 1 and a plugins array`
    );
  }
  for (const [index, entry] of value.plugins.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.specifier !== "string" ||
      entry.specifier.trim().length === 0 ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean") ||
      (entry.config !== undefined && !isRecord(entry.config)) ||
      (entry.remote !== undefined && !isRemoteSpec(entry.remote)) ||
      (entry.permissions !== undefined &&
        (!Array.isArray(entry.permissions) ||
          entry.permissions.some(
            (permission) =>
              typeof permission !== "string" ||
              !(PLUGIN_PERMISSIONS as readonly string[]).includes(permission)
          ))) ||
      (entry.secrets !== undefined &&
        (!isRecord(entry.secrets) ||
          Object.entries(entry.secrets).some(
            ([key, variable]) =>
              !isConfigPath(key) ||
              typeof variable !== "string" ||
              variable.length === 0
          )))
    ) {
      throw new Error(
        `plugin manifest "${path}" has an invalid entry at index ${index}`
      );
    }
  }
}

function assertPluginExport(
  value: unknown,
  specifier: string
): asserts value is BotPlugin {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(value.name) ||
    typeof value.version !== "string" ||
    typeof value.setup !== "function"
  ) {
    throw new Error(
      `plugin "${specifier}" must default-export a valid BotPlugin object`
    );
  }
}

const REMOTE_NUMBER_KEYS = [
  "handshakeTimeoutMs",
  "initializeTimeoutMs",
  "commandTimeoutMs",
  "taskTimeoutMs",
  "shutdownGraceMs"
] as const;
const REPLY_WINDOW_KEYS = ["ttlMs", "perConversation", "total"] as const;
const RESTART_NUMBER_KEYS = [
  "maxRestarts",
  "baseDelayMs",
  "maxDelayMs",
  "stableAfterMs"
] as const;

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRemoteSpec(value: unknown): value is RemotePluginSpec {
  if (!isRecord(value)) {
    return false;
  }
  const { restart } = value;
  return (
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    (value.args === undefined ||
      (Array.isArray(value.args) &&
        value.args.every((arg) => typeof arg === "string"))) &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.name === undefined ||
      (typeof value.name === "string" &&
        /^[a-z0-9][a-z0-9._-]*$/u.test(value.name))) &&
    (value.inheritEnv === undefined ||
      (Array.isArray(value.inheritEnv) &&
        value.inheritEnv.every(
          (name) => typeof name === "string" && name.length > 0
        ))) &&
    (value.replyWindow === undefined ||
      (isRecord(value.replyWindow) &&
        REPLY_WINDOW_KEYS.every(
          (key) =>
            (value.replyWindow as Record<string, unknown>)[key] === undefined ||
            isNonNegativeNumber(
              (value.replyWindow as Record<string, unknown>)[key]
            )
        ))) &&
    (value.env === undefined ||
      (isRecord(value.env) &&
        Object.values(value.env).every(
          (entry) => typeof entry === "string"
        ))) &&
    REMOTE_NUMBER_KEYS.every(
      (key) => value[key] === undefined || isNonNegativeNumber(value[key])
    ) &&
    (restart === undefined ||
      (isRecord(restart) &&
        RESTART_NUMBER_KEYS.every(
          (key) =>
            restart[key] === undefined || isNonNegativeNumber(restart[key])
        )))
  );
}

function isConfigPath(value: string): boolean {
  const segments = value.split(".");
  return (
    /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/u.test(value) &&
    segments.every(
      (segment) =>
        segment !== "__proto__" &&
        segment !== "prototype" &&
        segment !== "constructor"
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
