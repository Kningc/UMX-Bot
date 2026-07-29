import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotKernel, PluginLoadOptions } from "@qq-bot/core";
import type { BotPlugin, Logger } from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredPlugins } from "./plugin-loader.js";

class TestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qq-bot-plugin-loader-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("loadConfiguredPlugins", () => {
  it("loads the built-in manifest when no custom path is configured", async () => {
    const loaded: string[] = [];
    const bot = {
      async load(plugin: BotPlugin) {
        loaded.push(plugin.name);
      }
    } as BotKernel;

    await loadConfiguredPlugins(bot, {
      environment: {},
      logger: new TestLogger()
    });

    expect(loaded).toEqual(["help", "ping", "minecraft-status"]);
  });

  it("imports a manifest, resolves secrets and sorts dependencies", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "provider.mjs"),
      'export default { name: "provider", version: "1.0.0", setup() {} };'
    );
    await writeFile(
      join(directory, "consumer.mjs"),
      'export default { name: "consumer", version: "1.0.0", dependencies: ["provider"], setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            specifier: "./consumer.mjs",
            config: { endpoint: "https://example.com" },
            secrets: { "auth.token": "PLUGIN_TOKEN" }
          },
          { specifier: "./provider.mjs" },
          { specifier: "./disabled.mjs", enabled: false }
        ]
      })
    );
    const loaded: {
      plugin: BotPlugin;
      options: PluginLoadOptions;
    }[] = [];
    const bot = {
      async load(plugin: BotPlugin, options: PluginLoadOptions) {
        loaded.push({ plugin, options });
      }
    } as BotKernel;

    await loadConfiguredPlugins(bot, {
      manifestPath,
      environment: { PLUGIN_TOKEN: "secret" },
      logger: new TestLogger()
    });

    expect(loaded.map(({ plugin }) => plugin.name)).toEqual([
      "provider",
      "consumer"
    ]);
    expect(loaded[1]?.options.config).toEqual({
      endpoint: "https://example.com",
      auth: { token: "secret" }
    });
  });

  it("rejects missing secret environment variables", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "plugin.mjs"),
      'export default { name: "configured", version: "1.0.0", setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            specifier: "./plugin.mjs",
            secrets: { token: "MISSING_TOKEN" }
          }
        ]
      })
    );

    await expect(
      loadConfiguredPlugins({} as BotKernel, {
        manifestPath,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow('requires environment variable "MISSING_TOKEN"');
  });

  it("reports dependency cycles before loading any plugin", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "a.mjs"),
      'export default { name: "a", version: "1.0.0", dependencies: ["b"], setup() {} };'
    );
    await writeFile(
      join(directory, "b.mjs"),
      'export default { name: "b", version: "1.0.0", dependencies: ["a"], setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { specifier: "./a.mjs" },
          { specifier: "./b.mjs" }
        ]
      })
    );
    let loadCalls = 0;
    const bot = {
      async load() {
        loadCalls += 1;
      }
    } as unknown as BotKernel;

    await expect(
      loadConfiguredPlugins(bot, {
        manifestPath,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow("plugin dependency cycle detected");
    expect(loadCalls).toBe(0);
  });

  it("rejects prototype-mutating secret paths", async () => {
    const directory = await createTemporaryDirectory();
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            specifier: "./plugin.mjs",
            secrets: { "__proto__.token": "PLUGIN_TOKEN" }
          }
        ]
      })
    );

    await expect(
      loadConfiguredPlugins({} as BotKernel, {
        manifestPath,
        environment: { PLUGIN_TOKEN: "secret" },
        logger: new TestLogger()
      })
    ).rejects.toThrow("invalid entry");
    expect(({} as { token?: string }).token).toBeUndefined();
  });

  it("rejects unsupported plugin API versions before setup", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "future.mjs"),
      'export default { name: "future", version: "1.0.0", apiVersion: 2, setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ specifier: "./future.mjs" }]
      })
    );
    let loadCalls = 0;
    const bot = {
      async load() {
        loadCalls += 1;
      }
    } as unknown as BotKernel;

    await expect(
      loadConfiguredPlugins(bot, {
        manifestPath,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow("unsupported plugin API version 2");
    expect(loadCalls).toBe(0);
  });
});
