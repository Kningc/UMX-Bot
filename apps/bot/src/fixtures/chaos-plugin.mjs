// Test fixture: a remote plugin whose behaviour is steered by environment
// variables, so tests can make it misbehave in specific ways.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { connect } from "../../../../examples/remote-echo/client.mjs";

const mode = process.env.CHAOS_MODE ?? "normal";
const permissions = (process.env.CHAOS_PERMISSIONS ?? "")
  .split(",")
  .filter(Boolean);

if (process.env.CHAOS_PIDFILE) {
  appendFileSync(process.env.CHAOS_PIDFILE, `${process.pid}\n`);
}

let version = process.env.CHAOS_VERSION ?? "1.0.0";
if (mode === "version-bump") {
  // The second and later processes announce a different version.
  const marker = process.env.CHAOS_MARKER;
  if (existsSync(marker)) {
    version = "1.0.1";
  } else {
    writeFileSync(marker, "started");
  }
}

const bot = connect({
  protocol: Number(process.env.CHAOS_PROTOCOL ?? "1.1"),
  name: process.env.CHAOS_NAME ?? "chaos",
  version,
  permissions: mode === "bad-permission" ? ["middleware"] : permissions
});

const errorCode = async (run) => {
  try {
    await run();
    return "ok";
  } catch (error) {
    return `err:${error.code}`;
  }
};

let seen = 0;
let message;
let ticks = 0;
let cancelledTasks = 0;
let commandCancels = 0;
let lateCode = "none";
let firstMessageId;
let releaseSlowTask;

if (mode === "hang-shutdown") {
  bot.on("shutdown", () => new Promise(() => undefined));
}

bot.on("initialize", async (params) => {
  if (mode === "crash-after-first") {
    // Only the first process may initialise; every restart dies.
    if (existsSync(process.env.CHAOS_MARKER)) {
      process.exit(3);
    }
    writeFileSync(process.env.CHAOS_MARKER, "started");
  }
  if (mode === "hang-init") {
    await new Promise(() => undefined);
  }
  if (mode === "fail-init") {
    throw new Error("init refused");
  }
  if (mode === "init-crash") {
    process.exit(3);
  }
  if (mode === "noise") {
    process.stdout.write("this is not json\n");
    process.stderr.write("diagnostic line\n");
    bot.notify("log", { level: "warn", message: "from child", data: {} });
  }
  await bot.request("commands.register", {
    name: "chaos",
    description: "Misbehaving plugin",
    subcommands: [
      { name: "ping", description: "pong" },
      { name: "pid", description: "process id" },
      { name: "die", description: "exit", aliases: ["exit"] },
      { name: "hang", description: "never answers" },
      { name: "active", description: "active send" },
      { name: "forge", description: "reply to unknown message" },
      { name: "passive", description: "passive send then recall" },
      { name: "emit", description: "emit plugin event" },
      { name: "settings", description: "settings round trip" },
      { name: "kv", description: "store round trip" },
      { name: "metrics", description: "metrics round trip" },
      { name: "badreg", description: "invalid registration" },
      { name: "unknown", description: "unknown method" },
      { name: "media", description: "url media and inline media" },
      { name: "seen", description: "events seen" },
      { name: "config", description: "echo config" },
      { name: "env", description: "child environment" },
      { name: "minor", description: "protocol 1.1 calls" },
      { name: "sched", description: "schedule every" },
      { name: "schedcron", description: "schedule cron" },
      { name: "schedat", description: "schedule at" },
      { name: "schedslow", description: "schedule a slow task" },
      { name: "schedcancel", description: "cancel task" },
      { name: "taskinfo", description: "task counters" },
      { name: "slowreply", description: "replies after a delay" },
      { name: "latecode", description: "outcome of the late reply" },
      { name: "cas", description: "compare and set" },
      { name: "replyfirst", description: "reply to the first message seen" }
    ]
  });
  if (Number(process.env.CHAOS_PROTOCOL ?? "1.1") >= 1.1) {
    await bot.request("commands.register", {
      name: "chaosargs",
      description: "typed arguments",
      fallback: true,
      args: {
        count: { type: "integer", min: 1 },
        word: { type: "string", choices: ["a", "b"], optional: true }
      }
    });
  }
  await bot.request("events.subscribe", { event: "message.created" });
  chaosConfig = params.config;
});
let chaosConfig;

bot.on("event", ({ event, payload }) => {
  if (event === "message.created") {
    seen += 1;
    firstMessageId ??= payload.id;
  }
});

bot.on("command.cancel", () => {
  commandCancels += 1;
});

bot.on("task.run", async ({ name }) => {
  if (name === "slow") {
    await new Promise((resolve) => {
      releaseSlowTask = resolve;
    });
    return;
  }
  ticks += 1;
});

bot.on("task.cancel", ({ name }) => {
  cancelledTasks += 1;
  if (name === "slow") {
    releaseSlowTask?.();
  }
});

bot.on("command.execute", async (params) => {
  message = params.message;
  const reply = (text) => ({ reply: text });
  switch (params.subcommand) {
    case "ping":
      return reply("pong");
    case undefined:
      return reply(JSON.stringify(params.parsed));
    case "pid":
      return reply(String(process.pid));
    case "die":
      process.exit(1);
      return undefined;
    case "hang":
      return new Promise(() => undefined);
    case "active":
      return reply(
        await errorCode(() =>
          bot.request("messages.send", {
            message: {
              conversationId: "elsewhere",
              scope: "group",
              content: "hi",
              delivery: { type: "active", idempotencyKey: "k" }
            }
          })
        )
      );
    case "forge":
      return reply(
        await errorCode(() =>
          bot.request("messages.reply", { messageId: "nope", content: "x" })
        )
      );
    case "passive": {
      const sent = await bot.request("messages.send", {
        message: {
          conversationId: message.conversationId,
          scope: message.scope,
          content: "passive-ok",
          delivery: {
            type: "passive",
            target: { type: "message", messageId: message.id }
          }
        }
      });
      const forged = await errorCode(() =>
        bot.request("messages.send", {
          message: {
            conversationId: "other",
            scope: message.scope,
            content: "x",
            delivery: {
              type: "passive",
              target: { type: "message", messageId: message.id }
            }
          }
        })
      );
      await bot.request("messages.recall", { id: sent.id, message: sent });
      const stranger = await errorCode(() =>
        bot.request("messages.recall", { id: "not-mine", message: sent })
      );
      return reply(`${forged}/${stranger}`);
    }
    case "emit":
      return reply(
        await errorCode(() =>
          bot.request("events.emit", { event: "chaos.ping", payload: {} })
        )
      );
    case "settings": {
      await bot.request("settings.define", {
        key: "prefs",
        defaults: { greeting: "hi" }
      });
      const scope = {
        level: "conversation",
        platform: message.platform,
        scope: message.scope,
        conversationId: message.conversationId
      };
      await bot.request("settings.set", {
        key: "prefs",
        scope,
        overrides: { greeting: "yo" }
      });
      const value = await bot.request("settings.get", {
        key: "prefs",
        target: scope
      });
      await bot.request("settings.reset", { key: "prefs", scope });
      const missing = await errorCode(() =>
        bot.request("settings.get", { key: "undefined", target: scope })
      );
      return reply(`${value.greeting}/${missing}`);
    }
    case "kv": {
      await bot.request("store.set", { key: "a1", value: 1 });
      await bot.request("store.set", {
        key: "a2",
        value: { n: 2 },
        ttlMs: 60000
      });
      const listed = await bot.request("store.list", { prefix: "a" });
      const removed = await bot.request("store.delete", { key: "a1" });
      const gone = await bot.request("store.get", { key: "a1" });
      return reply(`${listed.map((entry) => entry.key)}|${removed}|${gone}`);
    }
    case "metrics": {
      await bot.request("metrics.counter.inc", {
        name: "hits",
        help: "hits",
        labelNames: ["kind"],
        labels: { kind: "a" },
        value: 2
      });
      await bot.request("metrics.gauge.set", {
        name: "level",
        help: "level",
        value: 5
      });
      await bot.request("metrics.gauge.add", {
        name: "level",
        help: "level",
        value: 1
      });
      await bot.request("metrics.histogram.observe", {
        name: "latency",
        help: "latency",
        buckets: [1, 10],
        value: 3
      });
      const wrongKind = await errorCode(() =>
        bot.request("metrics.gauge.set", { name: "hits", help: "x", value: 1 })
      );
      const badName = await errorCode(() =>
        bot.request("metrics.counter.inc", { name: "Bad-Name", help: "x" })
      );
      return reply(`${wrongKind}/${badName}`);
    }
    case "badreg":
      return reply(
        [
          await errorCode(() => bot.request("commands.register", { name: 5 })),
          await errorCode(() =>
            bot.request("commands.register", {
              name: "x",
              description: "d",
              args: { Bad: { type: "string" } }
            })
          ),
          await errorCode(() =>
            bot.request("commands.register", {
              name: "x",
              description: "d",
              args: { n: { type: "float" } }
            })
          ),
          await errorCode(() =>
            bot.request("commands.register", {
              name: "x",
              description: "d",
              args: {
                a: { type: "string", rest: true },
                b: { type: "boolean" }
              }
            })
          )
        ].join("/")
      );
    case "env":
      return reply(
        JSON.stringify({
          inherit: process.env.QQ_TEST_INHERIT ?? null,
          secret: process.env.QQ_TEST_SECRET ?? null,
          extra: process.env.CHAOS_EXTRA ?? null
        })
      );
    case "unknown":
      return reply(await errorCode(() => bot.request("nope.method", {})));
    case "media": {
      const inline = await errorCode(() =>
        bot.request("messages.reply", {
          messageId: message.id,
          content: {
            media: [{ type: "image", source: { type: "data", data: "AA==" } }]
          }
        })
      );
      return {
        reply: {
          text: inline,
          media: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/a.png" }
            }
          ]
        }
      };
    }
    case "minor":
      return reply(
        [
          await errorCode(() =>
            bot.request("scheduler.every", { name: "v", intervalMs: 1000 })
          ),
          await errorCode(() =>
            bot.request("store.compareAndSet", {
              key: "k",
              expected: null,
              value: 1
            })
          )
        ].join("/")
      );
    case "sched":
      await bot.request("scheduler.every", { name: "tick", intervalMs: 20 });
      return reply(
        await errorCode(() =>
          bot.request("scheduler.every", { name: "tick", intervalMs: 20 })
        )
      );
    case "schedcron":
      await bot.request("scheduler.cron", {
        name: "cron",
        expression: "* * * * *",
        timezone: "utc",
        overlap: "skip"
      });
      return reply(
        [
          await errorCode(() =>
            bot.request("scheduler.cron", { name: "c2", expression: "x" })
          ),
          await errorCode(() =>
            bot.request("scheduler.cron", {
              name: "c3",
              expression: "* * * * *",
              timezone: "mars"
            })
          ),
          await errorCode(() =>
            bot.request("scheduler.every", { name: "c4", intervalMs: 0 })
          ),
          await errorCode(() =>
            bot.request("scheduler.every", {
              name: "c5",
              intervalMs: 10,
              overlap: "maybe"
            })
          )
        ].join("/")
      );
    case "schedat":
      await bot.request("scheduler.at", {
        name: "once",
        when: new Date(Date.now() + 30).toISOString()
      });
      return reply(
        await errorCode(() =>
          bot.request("scheduler.at", { name: "bad", when: "never" })
        )
      );
    case "schedslow":
      await bot.request("scheduler.every", {
        name: "slow",
        intervalMs: 100000,
        runImmediately: true
      });
      return reply("scheduled");
    case "schedcancel":
      return reply(
        String(await bot.request("scheduler.cancel", { name: "tick" }))
      );
    case "taskinfo":
      return reply(`${ticks}|${cancelledTasks}|${commandCancels}`);
    case "slowreply":
      setTimeout(async () => {
        lateCode = await errorCode(() =>
          bot.request("messages.reply", {
            messageId: message.id,
            invocationId: params.invocationId,
            content: "late"
          })
        );
      }, 300);
      return new Promise(() => undefined);
    case "latecode":
      return reply(`${lateCode}|${commandCancels}`);
    case "cas": {
      const first = await bot.request("store.compareAndSet", {
        key: "cas",
        expected: null,
        value: { b: 1, a: 2 }
      });
      const stale = await bot.request("store.compareAndSet", {
        key: "cas",
        expected: null,
        value: 3
      });
      const reordered = await bot.request("store.compareAndSet", {
        key: "cas",
        expected: { a: 2, b: 1 },
        value: null
      });
      const gone = await bot.request("store.get", { key: "cas" });
      return reply(
        `${first.swapped}|${stale.swapped}:${JSON.stringify(stale.current)}|${reordered.swapped}|${gone}`
      );
    }
    case "replyfirst":
      return reply(
        await errorCode(() =>
          bot.request("messages.reply", {
            messageId: firstMessageId,
            content: "to the first"
          })
        )
      );
    case "seen":
      return reply(String(seen));
    case "config":
      return reply(JSON.stringify(chaosConfig));
    default:
      return reply("fallback");
  }
});

if (mode === "bad-hello") {
  await bot
    .request("hello", { protocol: 99, name: "chaos", version: "1.0.0" })
    .catch(() => undefined);
} else if (mode !== "no-hello") {
  await bot.hello();
}
