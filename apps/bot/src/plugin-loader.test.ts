import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
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
        plugins: [{ specifier: "./a.mjs" }, { specifier: "./b.mjs" }]
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
      'export default { name: "future", version: "1.0.0", apiVersion: 3, setup() {} };'
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
    ).rejects.toThrow("unsupported plugin API version 3");
    expect(loadCalls).toBe(0);
  });
});

describe("manifest permissions and hot reload limit", () => {
  it("passes manifest permissions through and rejects unknown ones", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "p.mjs"),
      'export default { name: "perm", version: "1.0.0", setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ specifier: "./p.mjs", permissions: ["scheduler"] }]
      })
    );
    const loaded: unknown[] = [];
    const bot = {
      async load(_plugin: unknown, options: unknown) {
        loaded.push(options);
      }
    } as unknown as BotKernel;
    await loadConfiguredPlugins(bot, {
      manifestPath,
      environment: {},
      logger: new TestLogger()
    });
    expect(loaded).toEqual([{ config: {}, permissions: ["scheduler"] }]);

    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ specifier: "./p.mjs", permissions: ["teleport"] }]
      })
    );
    await expect(
      loadConfiguredPlugins(bot, {
        manifestPath,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow("invalid entry");
  });

  it("refuses code-reloading reloads past the limit", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, "p.mjs"),
      'export default { name: "hot", version: "1.0.0", setup() {} };'
    );
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, plugins: [{ specifier: "./p.mjs" }] })
    );
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(_data: unknown, message?: string) {
        warnings.push(message ?? "");
      },
      error() {},
      child() {
        return logger;
      }
    };
    const bot = {
      async load() {},
      async unload() {
        return true;
      },
      getHealth() {
        return { plugins: [] };
      }
    } as unknown as BotKernel;
    const manager = await loadConfiguredPlugins(bot, {
      manifestPath,
      environment: {},
      logger,
      maxHotReloads: 4
    });
    for (let index = 0; index < 4; index += 1) {
      await manager.reload(bot, "hot");
    }
    expect(
      warnings.some((message) => message.includes("close to the limit"))
    ).toBe(true);
    await expect(manager.reload(bot, "hot")).rejects.toThrow("请重启进程");
  });
});

async function closePlugin(plugin: BotPlugin | undefined): Promise<void> {
  await (plugin as unknown as { close(): Promise<void> }).close();
}

describe("remote plugin manifest entries", () => {
  const echoScript = fileURLToPath(
    new URL("../../../examples/remote-echo/plugin.mjs", import.meta.url)
  );

  async function writeManifest(plugins: unknown[]): Promise<string> {
    const directory = await createTemporaryDirectory();
    const manifestPath = join(directory, "plugins.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, plugins })
    );
    return manifestPath;
  }

  function recordingBot() {
    const loaded: { plugin: BotPlugin; options: PluginLoadOptions }[] = [];
    const bot = {
      async load(plugin: BotPlugin, options: PluginLoadOptions) {
        loaded.push({ plugin, options });
      }
    } as BotKernel;
    return { bot, loaded };
  }

  const remoteEntry = {
    specifier: "remote:echo",
    permissions: [],
    remote: {
      command: process.execPath,
      args: [echoScript],
      shutdownGraceMs: 300
    }
  };

  it("spawns the child and presents it as a restricted plugin", async () => {
    const manifestPath = await writeManifest([remoteEntry]);
    const { bot, loaded } = recordingBot();
    await loadConfiguredPlugins(bot, {
      manifestPath,
      environment: {},
      logger: new TestLogger()
    });
    const [entry] = loaded;
    expect(entry?.plugin.name).toBe("remote-echo");
    expect(entry?.plugin.permissions).toEqual([]);
    expect(entry?.options.permissions).toEqual([]);
    await closePlugin(entry?.plugin);
  });

  it("closes children when a later plugin fails to load", async () => {
    const manifestPath = await writeManifest([remoteEntry]);
    let closed = false;
    const bot = {
      async load(plugin: BotPlugin) {
        const remote = plugin as unknown as { close(): Promise<void> };
        const close = remote.close.bind(remote);
        remote.close = async () => {
          closed = true;
          await close();
        };
        throw new Error("load refused");
      }
    } as unknown as BotKernel;
    await expect(
      loadConfiguredPlugins(bot, {
        manifestPath,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow("load refused");
    expect(closed).toBe(true);
  });

  it("closes children on duplicate names and reports spawn failures", async () => {
    const duplicate = await writeManifest([
      remoteEntry,
      { ...remoteEntry, specifier: "remote:echo-2" }
    ]);
    await expect(
      loadConfiguredPlugins(recordingBot().bot, {
        manifestPath: duplicate,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow(/duplicate plugin name/u);

    const broken = await writeManifest([
      { specifier: "remote:nope", remote: { command: "/no/such/binary" } }
    ]);
    await expect(
      loadConfiguredPlugins(recordingBot().bot, {
        manifestPath: broken,
        environment: {},
        logger: new TestLogger()
      })
    ).rejects.toThrow('failed to start remote plugin "remote:nope"');
  });

  it("validates the remote section", async () => {
    for (const remote of [
      "node",
      {},
      { command: "" },
      { command: "node", args: [1] },
      { command: "node", cwd: 5 },
      { command: "node", env: { A: 1 } },
      { command: "node", commandTimeoutMs: -1 },
      { command: "node", restart: { maxRestarts: "x" } },
      { command: "node", restart: 3 },
      { command: "node", name: "Bad Name" },
      { command: "node", inheritEnv: [1] },
      { command: "node", replyWindow: { ttlMs: "x" } },
      { command: "node", replyWindow: 4 }
    ]) {
      const manifestPath = await writeManifest([
        { specifier: "remote:x", remote }
      ]);
      await expect(
        loadConfiguredPlugins(recordingBot().bot, {
          manifestPath,
          environment: {},
          logger: new TestLogger()
        })
      ).rejects.toThrow(/invalid entry/u);
    }
  });

  it("enables a remote entry by specifier and skips it when probing by name", async () => {
    const manifestPath = await writeManifest([
      { ...remoteEntry, enabled: false },
      { specifier: "./local.mjs" }
    ]);
    const directory = dirname(manifestPath);
    await writeFile(
      join(directory, "local.mjs"),
      'export default { name: "local", version: "1.0.0", setup() {} };'
    );
    const { bot, loaded } = recordingBot();
    const manager = await loadConfiguredPlugins(bot, {
      manifestPath,
      environment: {},
      logger: new TestLogger()
    });
    expect(loaded.map((entry) => entry.plugin.name)).toEqual(["local"]);
    const named = bot as unknown as { getHealth(): { plugins: unknown[] } };
    named.getHealth = () => ({ plugins: [] });
    await expect(manager.enable(bot, "remote-echo")).rejects.toThrow(
      /no manifest entry/u
    );
    await expect(manager.enable(bot, "remote:echo")).resolves.toBe(true);
    await closePlugin(loaded.at(-1)?.plugin);
  });
});
