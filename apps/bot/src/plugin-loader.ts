import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertPluginVersion,
  normalizePluginDependency,
  satisfiesPluginVersion
} from "@qq-bot/core";
import type { BotKernel, PluginLoadOptions } from "@qq-bot/core";
import {
  LEGACY_PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS
} from "@qq-bot/plugin-sdk";
import type { BotPlugin, Logger } from "@qq-bot/plugin-sdk";

export interface PluginManifestEntry {
  specifier: string;
  enabled?: boolean;
  config?: Readonly<Record<string, unknown>>;
  secrets?: Readonly<Record<string, string>>;
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
    { specifier: "@qq-bot/plugin-help" },
    { specifier: "@qq-bot/plugin-ping" },
    { specifier: "@qq-bot/plugin-minecraft-status" }
  ]
};

export async function loadConfiguredPlugins(
  bot: BotKernel,
  options: {
    manifestPath?: string;
    environment?: NodeJS.ProcessEnv;
    logger: Logger;
  }
): Promise<void> {
  const manifestPath = options.manifestPath
    ? resolve(options.manifestPath)
    : undefined;
  const manifest = manifestPath
    ? await readManifest(manifestPath)
    : defaultManifest;
  const baseDirectory = manifestPath ? dirname(manifestPath) : process.cwd();
  const plugins = await resolvePlugins(
    manifest,
    baseDirectory,
    options.environment ?? process.env
  );

  for (const resolvedPlugin of sortPluginsByDependencies(plugins)) {
    await bot.load(resolvedPlugin.plugin, resolvedPlugin.options);
    options.logger.info(
      {
        plugin: resolvedPlugin.plugin.name,
        version: resolvedPlugin.plugin.version,
        specifier: resolvedPlugin.specifier
      },
      "configured plugin loaded"
    );
  }
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
  environment: NodeJS.ProcessEnv
): Promise<ResolvedPlugin[]> {
  const resolved: ResolvedPlugin[] = [];
  const names = new Set<string>();

  for (const entry of manifest.plugins) {
    if (entry.enabled === false) {
      continue;
    }
    const specifier = resolveSpecifier(entry.specifier, baseDirectory);
    let imported: Record<string, unknown>;
    try {
      imported = (await import(specifier)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`failed to import plugin "${entry.specifier}"`, {
        cause: error
      });
    }
    const plugin = imported.default;
    assertPluginExport(plugin, entry.specifier);
    assertPluginVersion(plugin.version, `plugin "${plugin.name}" version`);
    const apiVersion =
      plugin.apiVersion ?? LEGACY_PLUGIN_API_VERSION;
    if (
      !SUPPORTED_PLUGIN_API_VERSIONS.some(
        (supported) => supported === apiVersion
      )
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
    resolved.push({
      plugin,
      options: {
        config: resolveConfig(entry, environment)
      },
      specifier: entry.specifier
    });
  }

  return resolved;
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
        !satisfiesPluginVersion(
          provider.plugin.version,
          dependency.version
        )
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

function resolveSpecifier(specifier: string, baseDirectory: string): string {
  if (specifier.startsWith(".")) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  if (isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}

function assertManifest(value: unknown, path: string): asserts value is PluginManifest {
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
