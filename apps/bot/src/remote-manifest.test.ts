import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BotKernel } from "@umx-bot/core";
import type {
  BotAdapter,
  IncomingMessage,
  Logger,
  OutgoingMessage,
  SentMessage
} from "@umx-bot/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredPlugins, PluginManager } from "./plugin-loader.js";

const chaosScript = fileURLToPath(
  new URL("./fixtures/chaos-plugin.mjs", import.meta.url)
);

class QuietLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class TestAdapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  private onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;
  public async start(
    onMessage: (message: IncomingMessage) => Promise<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }
  public async stop(): Promise<void> {}
  public async send(message: OutgoingMessage): Promise<SentMessage> {
    this.sent.push(message);
    return {
      platform: this.name,
      scope: message.scope,
      conversationId: message.conversationId,
      id: `sent-${this.sent.length}`,
      timestamp: new Date()
    };
  }
  public async say(content: string): Promise<string[]> {
    const before = this.sent.length;
    await this.onMessage?.({
      id: `m-${before}`,
      platform: this.name,
      scope: "group",
      conversationId: "room",
      author: { id: "u1", role: "member" },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
    return this.sent
      .slice(before)
      .map((m) => (typeof m.content === "string" ? m.content : ""));
  }
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Workspace {
  directory: string;
  manifestPath: string;
  pidFile: string;
  writeManifest(plugins: unknown[]): Promise<void>;
  pids(): Promise<number[]>;
}

async function workspace(): Promise<Workspace> {
  const directory = await mkdtemp(join(tmpdir(), "umx-bot-remote-manifest-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "plugins.json");
  const pidFile = join(directory, "pids");
  await writeFile(pidFile, "");
  return {
    directory,
    manifestPath,
    pidFile,
    writeManifest: (plugins) =>
      writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, plugins })),
    pids: async () =>
      (await readFile(pidFile, "utf8")).split("\n").filter(Boolean).map(Number)
  };
}

function chaosEntry(
  space: Workspace,
  overrides: Record<string, unknown> = {},
  remote: Record<string, unknown> = {},
  env: Record<string, string> = {}
) {
  return {
    specifier: "remote:chaos",
    remote: {
      name: "chaos",
      command: process.execPath,
      args: [chaosScript],
      env: { CHAOS_PIDFILE: space.pidFile, ...env },
      shutdownGraceMs: 300,
      restart: { baseDelayMs: 10, maxDelayMs: 20 },
      ...remote
    },
    ...overrides
  };
}

function createBot() {
  const adapter = new TestAdapter();
  const bot = new BotKernel({
    adapter,
    logger: new QuietLogger(),
    commandPrefix: "/"
  });
  return { adapter, bot };
}

async function expectAllDead(space: Workspace): Promise<void> {
  const pids = await space.pids();
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    expect(alive(pid), `pid ${pid} is still running`).toBe(false);
  }
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("remote plugins and the plugin manager", () => {
  it("manages a remote plugin by its expected name", async () => {
    const space = await workspace();
    await space.writeManifest([chaosEntry(space)]);
    const { bot, adapter } = createBot();
    const manager = await loadConfiguredPlugins(bot, {
      manifestPath: space.manifestPath,
      environment: { PATH: process.env.PATH ?? "" },
      logger: new QuietLogger()
    });
    await bot.start();
    cleanups.push(() => bot.stop());

    expect(await manager.list(bot)).toMatchObject([
      { name: "chaos", specifier: "remote:chaos", loaded: true }
    ]);
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);

    await expect(manager.disable(bot, "chaos")).resolves.toBe(true);
    expect((await manager.list(bot))[0]).toMatchObject({
      name: "chaos",
      loaded: false
    });
    await expectAllDead(space);

    await expect(manager.enable(bot, "chaos")).resolves.toBe(true);
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
    await manager.reload(bot, "chaos");
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
    expect(manager.reloadPicksUpCode("chaos")).toBe(false);
    expect((await space.pids()).length).toBe(3);
  });

  it("reload recovers a plugin that has given up restarting", async () => {
    const space = await workspace();
    await space.writeManifest([
      chaosEntry(space, {}, { restart: { maxRestarts: 0 } })
    ]);
    const { bot, adapter } = createBot();
    const manager = await loadConfiguredPlugins(bot, {
      manifestPath: space.manifestPath,
      environment: { PATH: process.env.PATH ?? "" },
      logger: new QuietLogger()
    });
    await bot.start();
    cleanups.push(() => bot.stop());

    await adapter.say("/chaos die");
    // Failed: the kernel still lists it, but its commands are gone.
    await waitFor(() => adapter.sent.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await adapter.say("/chaos ping")).toEqual([]);

    await manager.reload(bot, "chaos");
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
    expect((await space.pids()).length).toBe(2);
    expect(alive((await space.pids())[0] as number)).toBe(false);
  });
});

describe("no child process outlives a failed load", () => {
  // The chaos child declares messages.active; the manifest grants only
  // events.emit, so the kernel refuses to load it after it was spawned.
  const declared = { CHAOS_PERMISSIONS: "messages.active" };
  const narrow = { permissions: ["events.emit"] };

  it("kills the child when the kernel refuses to load it", async () => {
    const space = await workspace();
    await space.writeManifest([chaosEntry(space, narrow, {}, declared)]);
    await expect(
      loadConfiguredPlugins(createBot().bot, {
        manifestPath: space.manifestPath,
        environment: { PATH: process.env.PATH ?? "" },
        logger: new QuietLogger()
      })
    ).rejects.toThrow(/does not grant/u);
    await expectAllDead(space);
  });

  it("kills the child when the dependency sort fails", async () => {
    const space = await workspace();
    await writeFile(
      join(space.directory, "needy.mjs"),
      'export default { name: "needy", version: "1.0.0", dependencies: ["absent"], setup() {} };'
    );
    await space.writeManifest([
      chaosEntry(space),
      { specifier: "./needy.mjs" }
    ]);
    await expect(
      loadConfiguredPlugins(createBot().bot, {
        manifestPath: space.manifestPath,
        environment: { PATH: process.env.PATH ?? "" },
        logger: new QuietLogger()
      })
    ).rejects.toThrow(/missing dependency/u);
    await expectAllDead(space);
  });

  it("kills the replacement after a failed reload, and the old one is gone", async () => {
    const space = await workspace();
    await space.writeManifest([chaosEntry(space, {}, {}, declared)]);
    const { bot } = createBot();
    const manager = await loadConfiguredPlugins(bot, {
      manifestPath: space.manifestPath,
      environment: { PATH: process.env.PATH ?? "" },
      logger: new QuietLogger()
    });
    cleanups.push(() => bot.stop());

    await space.writeManifest([chaosEntry(space, narrow, {}, declared)]);
    await expect(manager.reload(bot, "chaos")).rejects.toThrow(
      /after it was unloaded/u
    );
    await expectAllDead(space);
    expect(bot.getHealth().plugins).toEqual([]);
  });

  it("kills the child when enabling fails", async () => {
    const space = await workspace();
    await space.writeManifest([
      chaosEntry(space, { enabled: false, ...narrow }, {}, declared)
    ]);
    const { bot } = createBot();
    const manager = new PluginManager({
      manifestPath: space.manifestPath,
      environment: { PATH: process.env.PATH ?? "" },
      logger: new QuietLogger()
    });
    await manager.loadAll(bot);
    expect(await space.pids()).toEqual([]);
    await expect(manager.enable(bot, "chaos")).rejects.toThrow(
      /does not grant/u
    );
    await expectAllDead(space);
  });

  it("kills the child when the announced name is not the expected one", async () => {
    const space = await workspace();
    await space.writeManifest([chaosEntry(space, {}, { name: "other" })]);
    await expect(
      loadConfiguredPlugins(createBot().bot, {
        manifestPath: space.manifestPath,
        environment: { PATH: process.env.PATH ?? "" },
        logger: new QuietLogger()
      })
    ).rejects.toThrow(/failed to start remote plugin/u);
    await expectAllDead(space);
  });
});
