import { rm } from "node:fs/promises";
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
import { connectRemotePlugin, type RemotePluginSpec } from "./remote-plugin.js";

const echoScript = fileURLToPath(
  new URL("../../../examples/remote-echo/plugin.mjs", import.meta.url)
);
const chaosScript = fileURLToPath(
  new URL("./fixtures/chaos-plugin.mjs", import.meta.url)
);

class CapturingLogger implements Logger {
  public readonly lines: string[] = [];
  public debug(): void {}
  public info(_data: unknown, message?: string): void {
    this.lines.push(`info ${message ?? ""}`);
  }
  public warn(_data: unknown, message?: string): void {
    this.lines.push(`warn ${message ?? ""}`);
  }
  public error(_data: unknown, message?: string): void {
    this.lines.push(`error ${message ?? ""}`);
  }
  public child(): Logger {
    return this;
  }
}

class TestAdapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  public readonly recalled: string[] = [];
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
  public async recall(message: SentMessage): Promise<void> {
    this.recalled.push(message.id);
  }

  public async say(
    content: string,
    conversationId = "room"
  ): Promise<string[]> {
    const before = this.sent.length;
    await this.onMessage?.({
      id: `m-${before}`,
      platform: this.name,
      scope: "group",
      conversationId,
      author: { id: "u1", role: "member" },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
    return this.sent.slice(before).map((message) => {
      const content = message.content;
      return typeof content === "string" ? content : (content.text ?? "");
    });
  }
}

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function chaosSpec(
  env: Record<string, string> = {},
  overrides: Partial<RemotePluginSpec> = {}
): RemotePluginSpec {
  return {
    command: process.execPath,
    args: [chaosScript],
    env,
    handshakeTimeoutMs: 3000,
    initializeTimeoutMs: 3000,
    commandTimeoutMs: 3000,
    shutdownGraceMs: 300,
    restart: { baseDelayMs: 10, maxDelayMs: 40 },
    ...overrides
  };
}

async function boot(
  spec: RemotePluginSpec,
  options: {
    permissions?: ("messages.active" | "events.emit" | "scheduler")[];
    environment?: NodeJS.ProcessEnv;
  } = {}
) {
  const logger = new CapturingLogger();
  const adapter = new TestAdapter();
  const bot = new BotKernel({ adapter, logger, commandPrefix: "/" });
  const plugin = await connectRemotePlugin(spec, {
    logger,
    ...(options.environment ? { environment: options.environment } : {})
  });
  cleanups.push(() => plugin.close());
  await bot.load(
    plugin,
    options.permissions ? { permissions: options.permissions } : {}
  );
  await bot.start();
  cleanups.push(() => bot.stop());
  return { bot, adapter, plugin, logger };
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

function alive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("example echo plugin", () => {
  it("serves commands, subcommands, store, events and metrics", async () => {
    const { bot, adapter, plugin } = await boot({
      command: process.execPath,
      args: [echoScript],
      shutdownGraceMs: 500
    });

    expect(plugin.name).toBe("remote-echo");
    expect(await adapter.say("/echo hello there")).toEqual(["hello there"]);
    expect(await adapter.say("/echo upper hello")).toEqual(["HELLO"]);
    expect(await adapter.say("/echo count")).toEqual(["echo count: 1"]);
    expect(await adapter.say("/echo count")).toEqual(["echo count: 2"]);
    await waitFor(() =>
      bot.getMetricsText().includes("remote_echo_messages_seen")
    );
    expect(bot.getMetricsText()).toMatch(/remote_echo_up\S* 1/u);
    expect(bot.getHealth().plugins[0]?.permissions).toEqual([]);

    const pid = plugin.status().pid;
    expect(alive(pid)).toBe(true);
    await bot.unload("remote-echo");
    expect(plugin.status().state).toBe("closed");
    expect(alive(pid)).toBe(false);
    expect(await adapter.say("/echo hello")).toEqual([]);
  });
});

describe("protocol and permissions", () => {
  it("round-trips settings, store, metrics, passive sends and recall", async () => {
    const { adapter, bot } = await boot(chaosSpec());

    expect(await adapter.say("/chaos settings")).toEqual(["yo/err:-32602"]);
    expect(await adapter.say("/chaos kv")).toEqual(["a1,a2|true|null"]);
    expect(await adapter.say("/chaos metrics")).toEqual([
      "err:-32602/err:-32602"
    ]);
    const metrics = bot.getMetricsText();
    expect(metrics).toContain("chaos_hits");
    expect(metrics).toContain("chaos_latency");

    const sent = await adapter.say("/chaos passive");
    expect(sent).toEqual(["passive-ok", "err:-32602/err:-32602"]);
    expect(adapter.recalled).toHaveLength(1);
  });

  it("denies powers the plugin was not granted", async () => {
    const { adapter } = await boot(chaosSpec());
    expect(await adapter.say("/chaos active")).toEqual(["err:-32001"]);
    expect(await adapter.say("/chaos emit")).toEqual(["err:-32001"]);
  });

  it("allows declared powers, and the manifest can narrow them", async () => {
    const granted = await boot(
      chaosSpec({ CHAOS_PERMISSIONS: "messages.active,events.emit" })
    );
    expect(await granted.adapter.say("/chaos active")).toContain("ok");
    expect(await granted.adapter.say("/chaos emit")).toEqual(["ok"]);
    expect(
      granted.adapter.sent.some((m) => m.conversationId === "elsewhere")
    ).toBe(true);
  });

  it("refuses a manifest grant that is smaller than the declaration", async () => {
    const logger = new CapturingLogger();
    const bot = new BotKernel({
      adapter: new TestAdapter(),
      logger
    });
    const plugin = await connectRemotePlugin(
      chaosSpec({ CHAOS_PERMISSIONS: "messages.active" }),
      { logger }
    );
    cleanups.push(() => plugin.close());
    await expect(
      bot.load(plugin, { permissions: ["events.emit"] })
    ).rejects.toThrow(/does not grant/u);
    // The loader owns the child until `setup` runs, and closes it on failure.
    await plugin.close();
    expect(plugin.status().state).toBe("closed");
  });

  it("rejects forged replies, bad registrations and unknown methods", async () => {
    const { adapter } = await boot(chaosSpec());
    expect(await adapter.say("/chaos forge")).toEqual(["err:-32602"]);
    expect(await adapter.say("/chaos badreg")).toEqual([
      "err:-32602/err:-32602/err:-32602/err:-32602"
    ]);
    expect(await adapter.say("/chaos unknown")).toEqual(["err:-32601"]);
  });

  it("only allows media by url and forwards events", async () => {
    const { adapter } = await boot(chaosSpec());
    expect(await adapter.say("/chaos media")).toEqual(["err:-32004"]);
    expect(adapter.sent.at(-1)?.content).toMatchObject({
      media: [{ type: "image" }]
    });
    const seen = await adapter.say("/chaos seen");
    expect(Number(seen[0])).toBeGreaterThanOrEqual(1);
  });

  it("passes config to initialize", async () => {
    const logger = new CapturingLogger();
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger, commandPrefix: "/" });
    const plugin = await connectRemotePlugin(chaosSpec(), { logger });
    cleanups.push(() => plugin.close());
    await bot.load(plugin, { config: { color: "blue" } });
    await bot.start();
    cleanups.push(() => bot.stop());
    expect(await adapter.say("/chaos config")).toEqual(['{"color":"blue"}']);
  });

  it("logs stray stdout, stderr and log notifications", async () => {
    const { logger } = await boot(chaosSpec({ CHAOS_MODE: "noise" }));
    await waitFor(() =>
      logger.lines.some((line) => line.includes("from child"))
    );
    expect(logger.lines.join("\n")).toContain("non-protocol output");
    expect(logger.lines.join("\n")).toContain("diagnostic line");
  });
});

describe("handshake failures", () => {
  const cases: [
    string,
    Record<string, string>,
    Partial<RemotePluginSpec>,
    RegExp
  ][] = [
    [
      "a protocol mismatch",
      { CHAOS_MODE: "bad-hello" },
      {},
      /unsupported protocol/u
    ],
    [
      "a permission remote plugins cannot use",
      { CHAOS_MODE: "bad-permission" },
      {},
      /not available to remote/u
    ],
    ["a bad version", { CHAOS_VERSION: "one" }, {}, /version/u],
    [
      "no hello",
      { CHAOS_MODE: "no-hello" },
      { handshakeTimeoutMs: 150 },
      /no hello/u
    ]
  ];
  for (const [label, env, overrides, pattern] of cases) {
    it(`rejects ${label}`, async () => {
      await expect(
        connectRemotePlugin(chaosSpec(env, overrides), {
          logger: new CapturingLogger()
        })
      ).rejects.toThrow(pattern);
    });
  }

  it("rejects a command that cannot be started", async () => {
    await expect(
      connectRemotePlugin(
        { command: "/definitely/not/a/binary" },
        { logger: new CapturingLogger() }
      )
    ).rejects.toThrow(/ENOENT/u);
  });

  it("rejects a child that exits before hello", async () => {
    await expect(
      connectRemotePlugin(
        { command: process.execPath, args: ["-e", "process.exit(2)"] },
        { logger: new CapturingLogger() }
      )
    ).rejects.toThrow(/exited/u);
  });

  it.each([
    ["hang-init", /timed out/u, { initializeTimeoutMs: 150 }],
    ["fail-init", /init refused/u, {}],
    ["init-crash", /unavailable|exited|closed/u, {}]
  ])(
    "fails setup when initialize goes wrong (%s)",
    async (mode, pattern, overrides) => {
      const logger = new CapturingLogger();
      const bot = new BotKernel({ adapter: new TestAdapter(), logger });
      const plugin = await connectRemotePlugin(
        chaosSpec({ CHAOS_MODE: mode }, overrides),
        { logger }
      );
      const pid = plugin.status().pid;
      await expect(bot.load(plugin)).rejects.toThrow(pattern);
      expect(plugin.status().state).toBe("closed");
      await waitFor(() => !alive(pid));
    }
  );

  it("setup fails when the plugin was already closed", async () => {
    const logger = new CapturingLogger();
    const bot = new BotKernel({ adapter: new TestAdapter(), logger });
    const plugin = await connectRemotePlugin(chaosSpec(), { logger });
    await plugin.close();
    await plugin.close();
    await expect(bot.load(plugin)).rejects.toThrow(/not connected/u);
  });
});

describe("timeouts, crashes and shutdown", () => {
  it("fails a command that outlives its timeout and keeps the child", async () => {
    const { adapter, plugin } = await boot(
      chaosSpec({}, { commandTimeoutMs: 150 })
    );
    expect(await adapter.say("/chaos hang")).toEqual([
      "命令执行失败，请稍后再试。"
    ]);
    expect(plugin.status().state).toBe("ready");
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
  });

  it("restarts a crashed child and re-registers its commands", async () => {
    const { adapter, plugin, bot, logger } = await boot(chaosSpec());
    const firstPid = plugin.status().pid;
    expect(await adapter.say("/chaos die")).toEqual([
      "命令执行失败，请稍后再试。"
    ]);
    await waitFor(
      () => plugin.status().state === "ready" && plugin.status().restarts === 1
    );
    expect(plugin.status().pid).not.toBe(firstPid);
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
    expect(bot.getMetricsText()).toMatch(/chaos_restarts_total\S* 1/u);
    expect(logger.lines.join("\n")).toContain("restarting remote plugin");

    // Unloading after a restart disposes the restarted registrations once.
    await expect(bot.unload("chaos")).resolves.toBe(true);
  });

  it("stops restarting after too many crashes", async () => {
    const { adapter, plugin } = await boot(
      chaosSpec({}, { restart: { maxRestarts: 0 } })
    );
    await adapter.say("/chaos die");
    await waitFor(() => plugin.status().state === "failed");
    expect(await adapter.say("/chaos ping")).toEqual([]);
  });

  it("backs off and gives up when restarts keep failing", async () => {
    const marker = join(tmpdir(), `qq-bot-chaos-${process.pid}-${Date.now()}`);
    cleanups.push(() => rm(marker, { force: true }));
    const { adapter, plugin, logger } = await boot(
      chaosSpec(
        { CHAOS_MODE: "crash-after-first", CHAOS_MARKER: marker },
        { restart: { maxRestarts: 2, baseDelayMs: 5, maxDelayMs: 10 } }
      )
    );
    await adapter.say("/chaos die");
    await waitFor(() => plugin.status().state === "failed");
    expect(
      logger.lines.filter((line) => line.includes("restart failed"))
    ).toHaveLength(2);
    expect(plugin.status().pid).toBeUndefined();
  });

  it("kills a child that ignores shutdown when closed", async () => {
    const { plugin, bot } = await boot(
      chaosSpec({ CHAOS_MODE: "hang-shutdown" }, { shutdownGraceMs: 100 })
    );
    const pid = plugin.status().pid;
    await bot.unload("chaos");
    expect(alive(pid)).toBe(false);
  });

  it("does not restart a plugin that was unloaded", async () => {
    const { plugin, bot } = await boot(chaosSpec());
    await bot.unload("chaos");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(plugin.status()).toMatchObject({ state: "closed", restarts: 0 });
  });
});

describe("protocol 1.1: scheduler", () => {
  const scheduled = { CHAOS_PERMISSIONS: "scheduler" };

  it("runs interval tasks in the child and cancels them on request", async () => {
    const { adapter, bot } = await boot(chaosSpec(scheduled));
    // The second registration with the same name is refused.
    expect(await adapter.say("/chaos sched")).toEqual(["err:-32602"]);
    await waitFor(() => bot.getMetricsText().includes("chaos"));
    const ticks = async () =>
      Number((await adapter.say("/chaos taskinfo"))[0]?.split("|")[0]);
    let before = 0;
    const deadline = Date.now() + 3000;
    while (before < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      before = await ticks();
    }
    expect(before).toBeGreaterThanOrEqual(2);
    expect(await adapter.say("/chaos schedcancel")).toEqual(["true"]);
    expect(await adapter.say("/chaos schedcancel")).toEqual(["false"]);
    const after = await ticks();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await ticks()).toBe(after);
    expect(bot.getMetricsText()).toContain("tick");
  });

  it("validates cron and one-shot tasks", async () => {
    const { adapter } = await boot(chaosSpec(scheduled));
    expect(await adapter.say("/chaos schedcron")).toEqual([
      "err:-32603/err:-32602/err:-32602/err:-32602"
    ]);
    expect(await adapter.say("/chaos schedat")).toEqual(["err:-32602"]);
    const deadline = Date.now() + 3000;
    let ran = "0";
    while (ran === "0" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      ran = (await adapter.say("/chaos taskinfo"))[0]?.split("|")[0] ?? "0";
    }
    expect(ran).toBe("1");
  });

  it("signals cancellation when a task outlives taskTimeoutMs", async () => {
    const { adapter } = await boot(
      chaosSpec(scheduled, { taskTimeoutMs: 100 })
    );
    await adapter.say("/chaos schedslow");
    const deadline = Date.now() + 3000;
    let info = "";
    while (!/\|[1-9]\d*\|/u.test(info) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      info = (await adapter.say("/chaos taskinfo"))[0] ?? "";
    }
    expect(info).toMatch(/^0\|[1-9]\d*\|/u);
  });

  it("needs the scheduler permission", async () => {
    const { adapter } = await boot(chaosSpec());
    // The denied registration makes the command itself fail.
    expect(await adapter.say("/chaos sched")).toEqual([
      "命令执行失败，请稍后再试。"
    ]);
  });

  it("drops tasks when the child crashes and starts clean after a restart", async () => {
    const { adapter, plugin } = await boot(chaosSpec(scheduled));
    await adapter.say("/chaos sched");
    await adapter.say("/chaos die");
    await waitFor(
      () => plugin.status().state === "ready" && plugin.status().restarts === 1
    );
    expect(await adapter.say("/chaos taskinfo")).toEqual(["0|0|0"]);
    // The name is free again, so registering succeeds before it collides.
    expect(await adapter.say("/chaos sched")).toEqual(["err:-32602"]);
  });
});

describe("protocol 1.1: cancellation, windows, args, store", () => {
  it("sends command.cancel on timeout and refuses the late reply", async () => {
    const { adapter } = await boot(chaosSpec({}, { commandTimeoutMs: 100 }));
    expect(await adapter.say("/chaos slowreply")).toEqual([
      "命令执行失败，请稍后再试。"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await adapter.say("/chaos latecode")).toEqual(["err:-32005|1"]);
    expect(adapter.sent.some((m) => m.content === "late")).toBe(false);
  });

  it("keeps a quiet conversation repliable while another one is busy", async () => {
    const { adapter } = await boot(chaosSpec());
    await adapter.say("first words");
    for (let index = 0; index < 300; index += 1) {
      await adapter.say(`noise ${index}`, "busy-room");
    }
    expect(await adapter.say("/chaos replyfirst")).toEqual([
      "to the first",
      "ok"
    ]);
  });

  it("validates declared args on the host and passes the parsed result", async () => {
    const { adapter } = await boot(chaosSpec());
    expect(await adapter.say("/chaosargs 3 a")).toEqual([
      '{"count":3,"word":"a"}'
    ]);
    expect(await adapter.say("/chaosargs 3")).toEqual(['{"count":3}']);
    const rejected = await adapter.say("/chaosargs 0");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).not.toContain("{");
    const wrongChoice = await adapter.say("/chaosargs 3 zzz");
    expect(wrongChoice[0]).not.toContain("{");
  });

  it("compares and sets with structural equality", async () => {
    const { adapter } = await boot(chaosSpec());
    expect(await adapter.say("/chaos cas")).toEqual([
      'true|false:{"b":1,"a":2}|true|null'
    ]);
  });

  it("keeps protocol 1 children working but without 1.1 calls", async () => {
    const { adapter, plugin } = await boot(chaosSpec({ CHAOS_PROTOCOL: "1" }));
    expect(plugin.name).toBe("chaos");
    expect(await adapter.say("/chaos minor")).toEqual([
      "err:-32004/err:-32004"
    ]);
    expect(await adapter.say("/chaos ping")).toEqual(["pong"]);
  });

  it("rejects the scheduler permission from a protocol 1 child", async () => {
    await expect(
      connectRemotePlugin(
        chaosSpec({ CHAOS_PROTOCOL: "1", CHAOS_PERMISSIONS: "scheduler" }),
        { logger: new CapturingLogger() }
      )
    ).rejects.toThrow(/not available to remote/u);
  });
});

describe("manifest name and environment", () => {
  it("fails the handshake when the announced name differs", async () => {
    await expect(
      connectRemotePlugin(chaosSpec({}, { name: "something-else" }), {
        logger: new CapturingLogger()
      })
    ).rejects.toThrow(/expects "something-else"/u);
    const { plugin } = await boot(chaosSpec({}, { name: "chaos" }));
    expect(plugin.name).toBe("chaos");
  });

  it("passes only PATH, inheritEnv and env to the child", async () => {
    const { adapter } = await boot(
      chaosSpec(
        { CHAOS_EXTRA: "x" },
        { inheritEnv: ["QQ_TEST_INHERIT", "QQ_TEST_MISSING"] }
      ),
      {
        environment: {
          PATH: process.env.PATH ?? "",
          QQ_TEST_INHERIT: "yes",
          QQ_TEST_SECRET: "hidden"
        }
      }
    );
    expect(await adapter.say("/chaos env")).toEqual([
      '{"inherit":"yes","secret":null,"extra":"x"}'
    ]);
  });
});

describe("restart identity", () => {
  it("names the field that changed when a restart is refused", async () => {
    const marker = join(tmpdir(), `qq-bot-ident-${process.pid}-${Date.now()}`);
    cleanups.push(() => rm(marker, { force: true }));
    const { adapter, plugin, logger } = await boot(
      chaosSpec(
        { CHAOS_MODE: "version-bump", CHAOS_MARKER: marker },
        { restart: { maxRestarts: 1, baseDelayMs: 5, maxDelayMs: 10 } }
      )
    );
    await adapter.say("/chaos die");
    await waitFor(() => plugin.status().state === "failed");
    expect(logger.lines.join("\n")).toContain("version: 1.0.0 -> 1.0.1");
  });
});
