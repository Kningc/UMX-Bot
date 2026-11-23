import { MemoryStore, StoreAccessPolicy } from "@umx-bot/core";
import type { OutgoingMessage, SentMessage } from "@umx-bot/plugin-sdk";
import {
  CommandArgumentError,
  createCollection,
  defineArgs,
  definePlugin,
  defineSubcommand,
  PermissionError
} from "@umx-bot/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginTestHost } from "./index.js";

afterEach(() => {
  vi.useRealTimers();
});

function textOf(message: OutgoingMessage | undefined): string {
  const content = message?.content;
  return typeof content === "string" ? content : (content?.text ?? "");
}

describe("command v2", () => {
  const plugin = definePlugin({
    name: "calc",
    version: "1.0.0",
    setup(context) {
      context.commands.register({
        name: "calc",
        description: "calculator",
        subcommands: [
          defineSubcommand({
            name: "add",
            aliases: ["plus"],
            description: "add two integers",
            args: defineArgs({
              a: { type: "integer" },
              b: { type: "integer", optional: true, min: 0 }
            }),
            async execute(command) {
              await command.reply(
                String(command.parsed.a + (command.parsed.b ?? 0))
              );
            }
          }),
          defineSubcommand({
            name: "secret",
            description: "admin only",
            permission: "admin",
            execute: async (command) => {
              await command.reply("secret");
            }
          })
        ]
      });
      context.commands.register({
        name: "ginfo",
        description: "group only",
        scopes: ["group"],
        async execute(command) {
          await command.reply("group");
        }
      });
    }
  });

  it("dispatches subcommands and aliases with typed arguments", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();
    expect(textOf((await host.receive("/calc add 2 3"))[0])).toBe("5");
    expect(textOf((await host.receive("/calc plus 4"))[0])).toBe("4");
  });

  it("explains argument errors with usage", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();
    const [missing] = await host.receive("/calc add");
    expect(textOf(missing)).toContain("缺少参数 a");
    expect(textOf(missing)).toContain("/calc add <a> [b]");
    expect(textOf((await host.receive("/calc add x"))[0])).toContain(
      "必须是整数"
    );
    expect(textOf((await host.receive("/calc add 1 -1"))[0])).toContain(
      "不能小于 0"
    );
    expect(textOf((await host.receive("/calc add 1 2 3"))[0])).toContain(
      "多余的参数"
    );
  });

  it("lists subcommands when none matches and there is no execute", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();
    const [reply] = await host.receive("/calc nope");
    expect(textOf(reply)).toContain("/calc add");
  });

  it("applies per-subcommand permissions and chat scopes", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();
    expect(textOf((await host.receive("/calc secret"))[0])).toContain(
      "权限不足"
    );
    expect(
      textOf((await host.receive("/calc secret", { role: "admin" }))[0])
    ).toBe("secret");
    expect(await host.receive("/ginfo", { scope: "direct" })).toEqual([]);
    expect(textOf((await host.receive("/ginfo"))[0])).toBe("group");
  });

  it("rejects commands with neither execute nor subcommands", async () => {
    const host = createPluginTestHost();
    await expect(
      host.load(
        definePlugin({
          name: "empty",
          version: "1.0.0",
          setup(context) {
            context.commands.register({ name: "x", description: "x" });
          }
        })
      )
    ).rejects.toThrow("needs an execute function or subcommands");
  });

  it("exposes subcommands and scopes in the command list", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.load(
      definePlugin({
        name: "lister",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "list-commands",
            description: "lists",
            async execute(command) {
              const summary = context.commands
                .list()
                .find((c) => c.name === "calc");
              await command.reply(
                JSON.stringify({
                  subs: summary?.subcommands?.map((sub) => sub.invocation),
                  scoped: context.commands
                    .list()
                    .find((c) => c.name === "ginfo")?.scopes
                })
              );
            }
          });
        }
      })
    );
    await host.start();
    expect(textOf((await host.receive("/list-commands"))[0])).toBe(
      '{"subs":["/calc add","/calc secret"],"scoped":["group"]}'
    );
  });
});

describe("defineArgs", () => {
  it("parses booleans, numbers, choices and rest arguments", () => {
    const schema = defineArgs({
      mode: { type: "string", choices: ["on", "off"] },
      ratio: { type: "number" },
      flag: { type: "boolean" },
      note: { type: "string", rest: true, optional: true }
    });
    expect(schema.usage).toBe("<on|off> <ratio> <flag> [note...]");
    expect(
      schema.parse({ args: ["on", "1.5", "是", "a", "b"], rawArgs: "" })
    ).toEqual({ mode: "on", ratio: 1.5, flag: true, note: "a b" });
    expect(() => schema.parse({ args: ["x", "1", "no"], rawArgs: "" })).toThrow(
      CommandArgumentError
    );
    expect(() =>
      schema.parse({ args: ["on", "1", "maybe"], rawArgs: "" })
    ).toThrow("true 或 false");
    expect(() =>
      schema.parse({ args: ["on", "abc", "no"], rawArgs: "" })
    ).toThrow("必须是数字");
    expect(() =>
      defineArgs({ a: { type: "string", rest: true }, b: { type: "string" } })
    ).toThrow("must be the last");
  });
});

describe("events, hooks and interactions", () => {
  it("emits command.executed with the outcome and records metrics", async () => {
    const host = createPluginTestHost();
    const seen: string[] = [];
    await host.load(
      definePlugin({
        name: "watcher",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "ok",
            description: "ok",
            async execute(command) {
              await command.reply("ok");
            }
          });
          context.commands.register({
            name: "boom",
            description: "boom",
            execute() {
              throw new Error("boom");
            }
          });
          context.commands.register({
            name: "admin",
            description: "admin",
            permission: "admin",
            execute() {}
          });
          context.events.on("command.executed", (event) => {
            seen.push(`${event.command}:${event.outcome}`);
          });
        }
      })
    );
    await host.start();
    await host.receive("/ok");
    await host.receive("/boom");
    await host.receive("/admin");
    expect(seen).toEqual(["ok:completed", "boom:failed", "admin:denied"]);
    const metrics = host.getMetricsText();
    expect(metrics).toContain(
      'qq_bot_command_executions_total{plugin="watcher",command="ok",outcome="completed"} 1'
    );
    expect(metrics).toContain("qq_bot_command_duration_seconds_count");
  });

  it("lets plugins publish and subscribe to namespaced events", async () => {
    const host = createPluginTestHost();
    const received: unknown[] = [];
    await host.load(
      definePlugin({
        name: "listener",
        version: "1.0.0",
        setup(context) {
          context.events.on("pub.hello" as never, (payload: unknown) => {
            received.push(payload);
          });
        }
      })
    );
    let emitter: (event: string, payload: unknown) => Promise<void> =
      async () => {};
    await host.load(
      definePlugin({
        name: "pub",
        version: "1.0.0",
        setup(context) {
          emitter = (event, payload) =>
            context.events.emit(event as never, payload as never);
        }
      })
    );
    await host.start();
    await emitter("pub.hello", { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
    expect(() => emitter("message.created", {})).toThrow(
      "can only emit events named"
    );
  });

  it("runs outbound hooks in priority order and lets them rewrite or split", async () => {
    const host = createPluginTestHost();
    await host.load(
      definePlugin({
        name: "outbound",
        version: "1.0.0",
        setup(context) {
          context.outbound.use(
            (message, next) => {
              const text =
                typeof message.content === "string" ? message.content : "";
              return next({ ...message, content: `[${text}]` });
            },
            { priority: 5 }
          );
          context.outbound.use(async (message, next) => {
            const text =
              typeof message.content === "string" ? message.content : "";
            let last: SentMessage | undefined;
            for (const part of text.split("|")) {
              last = await next({ ...message, content: part });
            }
            return last as SentMessage;
          });
          context.commands.register({
            name: "say",
            description: "say",
            async execute(command) {
              await command.reply("a|b");
            }
          });
        }
      })
    );
    await host.start();
    expect((await host.receive("/say")).map(textOf)).toEqual(["[a", "b]"]);
  });

  it("wraps hook failures with the plugin name", async () => {
    const host = createPluginTestHost();
    let failure: unknown;
    await host.load(
      definePlugin({
        name: "badhook",
        version: "1.0.0",
        setup(context) {
          context.outbound.use(() => {
            throw new Error("nope");
          });
          context.commands.register({
            name: "x",
            description: "x",
            async execute(command) {
              try {
                await command.reply("hi");
              } catch (error) {
                failure = error;
              }
            }
          });
        }
      })
    );
    await host.start();
    await host.receive("/x");
    expect((failure as Error).message).toContain(
      'outbound hook from plugin "badhook"'
    );
  });

  it("routes callback button presses to the plugin that built them", async () => {
    const host = createPluginTestHost();
    let data = "";
    await host.load(
      definePlugin({
        name: "buttons",
        version: "1.0.0",
        setup(context) {
          data = context.interactions.encode("refresh", "42");
          context.interactions.handle("refresh", async ({ payload, reply }) => {
            await reply(`refreshed ${payload}`);
          });
          context.interactions.handle("boom", () => {
            throw new Error("handler failure");
          });
        }
      })
    );
    await host.start();
    expect(data).toBe("buttons:refresh:42");
    const base = {
      platform: "test",
      scope: "group" as const,
      conversationId: "g1",
      eventId: "evt-1",
      timestamp: new Date()
    };
    await host.emit("interaction.created", { ...base, data });
    const [reply] = host.flush();
    expect(textOf(reply)).toBe("refreshed 42");
    expect(reply?.delivery).toEqual({
      type: "passive",
      target: { type: "event", eventId: "evt-1" }
    });
    // Unknown plugin, no data and a failing handler must all be harmless.
    await host.emit("interaction.created", { ...base, data: "other:refresh" });
    await host.emit("interaction.created", { ...base });
    await host.emit("interaction.created", { ...base, data: "nocolon" });
    await host.emit("interaction.created", { ...base, data: "buttons:boom" });
    expect(host.flush()).toEqual([]);
  });
});

describe("permissions and requirements", () => {
  const sender = (permissions?: readonly never[] | readonly string[]) =>
    definePlugin({
      name: "proactive",
      version: "1.0.0",
      ...(permissions ? { permissions: permissions as never } : {}),
      setup(context) {
        context.commands.register({
          name: "push",
          description: "push",
          async execute(command) {
            try {
              await context.messages.send({
                conversationId: "c",
                scope: "group",
                content: "hi",
                delivery: { type: "active", idempotencyKey: "k" }
              });
              await command.reply("sent");
            } catch (error) {
              await command.reply(
                error instanceof PermissionError ? error.permission : "other"
              );
            }
          }
        });
      }
    });

  it("keeps undeclared plugins unrestricted", async () => {
    const host = createPluginTestHost();
    await host.load(sender());
    await host.start();
    const out = await host.receive("/push");
    expect(out.map(textOf)).toEqual(["hi", "sent"]);
  });

  it("blocks powers a restricted plugin was not granted", async () => {
    const host = createPluginTestHost();
    await host.load(sender(["scheduler"]));
    await host.start();
    expect(textOf((await host.receive("/push"))[0])).toBe("messages.active");
    expect(host.getHealth().plugins[0]?.permissions).toEqual(["scheduler"]);
  });

  it("lets the manifest grant or restrict", async () => {
    const granted = createPluginTestHost();
    await granted.load(sender(["messages.active"]), {
      permissions: ["messages.active", "scheduler"]
    });
    await granted.start();
    expect((await granted.receive("/push")).map(textOf)).toEqual([
      "hi",
      "sent"
    ]);

    const insufficient = createPluginTestHost();
    await expect(
      insufficient.load(sender(["messages.active"]), {
        permissions: ["scheduler"]
      })
    ).rejects.toThrow("does not grant: messages.active");

    const restricted = createPluginTestHost();
    await restricted.load(sender(), { permissions: [] });
    await restricted.start();
    expect(textOf((await restricted.receive("/push"))[0])).toBe(
      "messages.active"
    );
  });

  it("rejects unknown permissions", async () => {
    const host = createPluginTestHost();
    await expect(host.load(sender(["teleport"]))).rejects.toThrow(
      'unknown permission "teleport"'
    );
  });

  it("gates scheduler, middleware, outbound and events.emit", async () => {
    const host = createPluginTestHost();
    const errors: string[] = [];
    await host.load(
      definePlugin({
        name: "limited",
        version: "1.0.0",
        permissions: [],
        setup(context) {
          const attempt = (name: string, action: () => unknown): void => {
            try {
              action();
            } catch (error) {
              errors.push(`${name}:${(error as PermissionError).permission}`);
            }
          };
          attempt("every", () => context.scheduler.every("t", 1_000, () => {}));
          attempt("cron", () =>
            context.scheduler.cron("t", "* * * * *", () => {})
          );
          attempt("at", () => context.scheduler.at("t", new Date(), () => {}));
          attempt("middleware", () =>
            context.middleware.use((_c, next) => next())
          );
          attempt("outbound", () => context.outbound.use((m, next) => next(m)));
          attempt("emit", () =>
            context.events.emit("limited.x" as never, {} as never)
          );
        }
      })
    );
    expect(errors).toEqual([
      "every:scheduler",
      "cron:scheduler",
      "at:scheduler",
      "middleware:middleware",
      "outbound:outbound",
      "emit:events.emit"
    ]);
  });

  it("checks requires against adapter capabilities and extensions", async () => {
    const host = createPluginTestHost({
      contextExtensions: [
        {
          name: "greeter",
          create: ({ pluginName }) => ({
            value: { hello: () => `hi ${pluginName}` }
          })
        }
      ]
    });
    await expect(
      host.load(
        definePlugin({
          name: "needs-stream",
          version: "1.0.0",
          requires: ["messages.stream"],
          setup() {}
        })
      )
    ).rejects.toThrow('requires "messages.stream"');
    await expect(
      host.load(
        definePlugin({
          name: "needs-db",
          version: "1.0.0",
          requires: ["db"],
          setup() {}
        })
      )
    ).rejects.toThrow('requires "db"');

    let greeting = "";
    await host.load(
      definePlugin({
        name: "uses-greeter",
        version: "1.0.0",
        requires: ["greeter"],
        setup(context) {
          greeting = (
            context as unknown as { greeter: { hello(): string } }
          ).greeter.hello();
        }
      })
    );
    expect(greeting).toBe("hi uses-greeter");
  });

  it("rejects reserved or duplicate extension names", () => {
    expect(() =>
      createPluginTestHost({
        contextExtensions: [{ name: "store", create: () => ({ value: 1 }) }]
      })
    ).toThrow("invalid context extension name");
  });

  it("disposes extension resources on unload", async () => {
    let disposed = 0;
    const host = createPluginTestHost({
      contextExtensions: [
        {
          name: "res",
          create: () => ({
            value: 1,
            dispose: () => {
              disposed += 1;
            }
          })
        }
      ]
    });
    await host.load(definePlugin({ name: "p", version: "1.0.0", setup() {} }));
    await host.unload("p");
    expect(disposed).toBe(1);
  });
});

describe("access policy", () => {
  it("disables plugins and commands per conversation, and blocks users", async () => {
    const access = new StoreAccessPolicy(new MemoryStore(), {
      exemptPlugins: ["core-tools"]
    });
    const host = createPluginTestHost({
      accessPolicy: access,
      ownerIds: ["boss"]
    });
    const load = (name: string) =>
      host.load(
        definePlugin({
          name,
          version: "1.0.0",
          setup(context) {
            context.commands.register({
              name: `${name}-a`,
              description: "a",
              async execute(command) {
                await command.reply(`${name}-a`);
              }
            });
            context.commands.register({
              name: `${name}-b`,
              description: "b",
              async execute(command) {
                await command.reply(`${name}-b`);
              }
            });
          }
        })
      );
    await load("games");
    await load("core-tools");
    await host.start();

    const chat = {
      platform: "test",
      scope: "group" as const,
      conversationId: "conversation-1"
    };
    await access.setPluginEnabled(chat, "games", false);
    expect(await host.receive("/games-a")).toEqual([]);
    expect(
      textOf((await host.receive("/games-a", { conversationId: "other" }))[0])
    ).toBe("games-a");
    await access.setPluginEnabled(chat, "games", true);
    expect(textOf((await host.receive("/games-a"))[0])).toBe("games-a");

    await access.setCommandEnabled(chat, "games-b", false);
    expect(await host.receive("/games-b")).toEqual([]);
    expect(textOf((await host.receive("/games-a"))[0])).toBe("games-a");
    expect(await access.inspect(chat)).toEqual({
      disabledPlugins: [],
      disabledCommands: ["games-b"]
    });
    await access.setCommandEnabled(chat, "games-b", true);
    expect(await access.inspect(chat)).toEqual({
      disabledPlugins: [],
      disabledCommands: []
    });

    await expect(
      access.setPluginEnabled(chat, "core-tools", false)
    ).rejects.toThrow("cannot be disabled");

    await access.setBlocked("test", "user-1", true);
    expect(await access.listBlocked("test")).toEqual(["user-1"]);
    expect(await host.receive("/games-a")).toEqual([]);
    // A group owner is blocked like anyone else; the list is platform-wide.
    expect(await host.receive("/games-a", { role: "owner" })).toEqual([]);
    // Bot owners are never locked out by the blocklist.
    await access.setBlocked("test", "boss", true);
    expect(
      textOf((await host.receive("/games-a", { authorId: "boss" }))[0])
    ).toBe("games-a");
    await access.setBlocked("test", "boss", false);
    await access.setBlocked("test", "user-1", false);
    expect(await access.listBlocked("test")).toEqual([]);
    expect(textOf((await host.receive("/games-a"))[0])).toBe("games-a");
  });

  it("replies with a reason when a custom policy supplies one", async () => {
    const host = createPluginTestHost({
      accessPolicy: { check: () => ({ allowed: false, reason: "维护中" }) }
    });
    await host.load(
      definePlugin({
        name: "p",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "x",
            description: "x",
            execute() {}
          });
        }
      })
    );
    await host.start();
    expect(textOf((await host.receive("/x"))[0])).toBe("维护中");
  });
});

describe("metrics", () => {
  it("exports plugin metrics and removes them when the plugin unloads", async () => {
    const host = createPluginTestHost();
    await host.load(
      definePlugin({
        name: "my-plugin",
        version: "1.0.0",
        setup(context) {
          const counter = context.metrics.counter("hits_total", "Hits.", {
            labels: ["kind"]
          });
          const gauge = context.metrics.gauge("depth", "Depth.");
          const histogram = context.metrics.histogram(
            "latency_seconds",
            "Latency.",
            {
              buckets: [1, 5]
            }
          );
          counter.inc({ kind: 'a"b' }, 2);
          counter.inc({ kind: 'a"b' });
          gauge.set(5);
          gauge.add(-2);
          histogram.observe(0.5);
          histogram.observe(3);
          histogram.observe(10);
          expect(() => counter.inc({})).toThrow("expects labels");
          expect(() => counter.inc({ kind: "x" }, -1)).toThrow("non-negative");
          expect(() => context.metrics.counter("Bad-Name", "x")).toThrow(
            "invalid metric name"
          );
          expect(() => context.metrics.gauge("hits_total", "x")).toThrow(
            "already defined differently"
          );
          expect(() =>
            context.metrics.counter("bad_label", "x", { labels: ["le"] })
          ).toThrow("invalid label");
          expect(() => context.metrics.counter("nohelp", " ")).toThrow(
            "needs a help text"
          );
        }
      })
    );
    const text = host.getMetricsText();
    expect(text).toContain(
      'qq_bot_plugin_my_plugin_hits_total{kind="a\\"b"} 3'
    );
    expect(text).toContain("qq_bot_plugin_my_plugin_depth 3");
    expect(text).toContain(
      'qq_bot_plugin_my_plugin_latency_seconds_bucket{le="1"} 1'
    );
    expect(text).toContain(
      'qq_bot_plugin_my_plugin_latency_seconds_bucket{le="5"} 2'
    );
    expect(text).toContain(
      'qq_bot_plugin_my_plugin_latency_seconds_bucket{le="+Inf"} 3'
    );
    expect(text).toContain("qq_bot_plugin_my_plugin_latency_seconds_count 3");
    await host.unload("my-plugin");
    expect(host.getMetricsText()).not.toContain("my_plugin");
  });
});

describe("scheduler", () => {
  it("fires cron tasks on schedule and reports runs as metrics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    const host = createPluginTestHost();
    let runs = 0;
    await host.load(
      definePlugin({
        name: "cronny",
        version: "1.0.0",
        setup(context) {
          context.scheduler.cron(
            "minutely",
            "* * * * *",
            () => {
              runs += 1;
            },
            { timezone: "utc" }
          );
          context.scheduler.cron(
            "failing",
            "* * * * *",
            () => {
              throw new Error("fail");
            },
            { timezone: "utc" }
          );
        }
      })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(3);
    const text = host.getMetricsText();
    expect(text).toContain(
      'qq_bot_scheduled_task_runs_total{task="cronny:minutely",outcome="ok"} 3'
    );
    expect(text).toContain(
      'qq_bot_scheduled_task_runs_total{task="cronny:failing",outcome="error"} 3'
    );
    await host.unload("cronny");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(3);
  });

  it("runs a one-shot task at the requested time", async () => {
    vi.useFakeTimers();
    const host = createPluginTestHost();
    const fired: string[] = [];
    await host.load(
      definePlugin({
        name: "oneshot",
        version: "1.0.0",
        setup(context) {
          context.scheduler.at("later", new Date(Date.now() + 5_000), () => {
            fired.push("later");
          });
          context.scheduler.at("past", new Date(Date.now() - 5_000), () => {
            fired.push("past");
          });
          expect(() =>
            context.scheduler.at("bad", new Date("nope"), () => {})
          ).toThrow("not a valid date");
        }
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual(["past"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toEqual(["past", "later"]);
  });

  it("catches up a missed cron run once after a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const store = new MemoryStore();
    let runs = 0;
    const plugin = definePlugin({
      name: "catchy",
      version: "1.0.0",
      setup(context) {
        context.scheduler.cron(
          "hourly",
          "0 * * * *",
          () => {
            runs += 1;
          },
          { timezone: "utc", catchUp: true }
        );
      }
    });

    const first = createPluginTestHost({ store });
    await first.load(plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(0); // first start only records the baseline
    await first.unload("catchy");

    vi.setSystemTime(new Date("2026-01-01T13:30:00Z"));
    const second = createPluginTestHost({ store });
    await second.load(plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await second.unload("catchy");

    // Nothing was missed this time.
    const third = createPluginTestHost({ store });
    await third.load(plugin);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
  });

  it("skips overlapping runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    const host = createPluginTestHost();
    let started = 0;
    await host.load(
      definePlugin({
        name: "slow",
        version: "1.0.0",
        setup(context) {
          context.scheduler.cron(
            "t",
            "* * * * *",
            () => {
              started += 1;
              return new Promise<void>((resolve) =>
                context.signal.addEventListener("abort", () => resolve())
              );
            },
            { timezone: "utc" }
          );
        }
      })
    );
    await vi.advanceTimersByTimeAsync(150_000);
    expect(started).toBe(1);
    expect(host.getMetricsText()).toContain('outcome="skipped"');
    await host.unload("slow");
  });
});

describe("storage ttl and collections", () => {
  it("expires entries and skips them in listings", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    await store.set("a", 1, { ttlMs: 1_000 });
    await store.set("b", 2);
    await store.set("c", 3, { ttlMs: 10_000 });
    await store.update<number>("c", (current) => (current ?? 0) + 1);
    expect((await store.list("")).map((entry) => entry.key)).toEqual([
      "a",
      "b",
      "c"
    ]);
    vi.advanceTimersByTime(1_500);
    expect(await store.get("a")).toBeUndefined();
    expect((await store.list("")).map((entry) => entry.key)).toEqual([
      "b",
      "c"
    ]);
    expect(await store.delete("a")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(await store.get("c")).toBeUndefined();
    await store.set("b", 9);
    vi.advanceTimersByTime(100_000);
    expect(await store.get("b")).toBe(9);
    await expect(store.set("x", 1, { ttlMs: 0 })).rejects.toThrow("ttlMs");
  });

  it("passes ttl through plugin and scoped stores", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const host = createPluginTestHost({ store });
    let pluginStore: import("@umx-bot/plugin-sdk").KeyValueStore | undefined;
    await host.load(
      definePlugin({
        name: "ttl",
        version: "1.0.0",
        setup(context) {
          pluginStore = context.store;
        }
      })
    );
    await pluginStore?.set("k", "v", { ttlMs: 500 });
    expect(await pluginStore?.get("k")).toBe("v");
    vi.advanceTimersByTime(600);
    expect(await pluginStore?.get("k")).toBeUndefined();
  });

  it("supports collections with find, sort, count and update", async () => {
    const store = new MemoryStore();
    const scores = createCollection<{ name: string; points: number }>(
      store,
      "scores"
    );
    await scores.put("a", { name: "a", points: 5 });
    await scores.put("b", { name: "b", points: 9 });
    await scores.put("c", { name: "c", points: 1 });
    await scores.update("c", (current) =>
      current ? { ...current, points: 20 } : current
    );
    expect(await scores.get("c")).toEqual({ name: "c", points: 20 });
    expect(await scores.count()).toBe(3);
    expect(await scores.count((value) => value.points > 6)).toBe(2);
    const top = await scores.find(undefined, {
      limit: 2,
      sort: (left, right) => right.value.points - left.value.points
    });
    expect(top.map((entry) => entry.id)).toEqual(["c", "b"]);
    expect(
      (await scores.find((value) => value.points < 6, { limit: 1 })).length
    ).toBe(1);
    expect(await scores.delete("a")).toBe(true);
    expect(await scores.count()).toBe(2);
    await expect(scores.find(undefined, { limit: 0 })).rejects.toThrow(
      "positive integer"
    );
    expect(() => createCollection(store, "Bad Name")).toThrow(
      "invalid collection name"
    );
    await expect(scores.put("", { name: "", points: 0 })).rejects.toThrow(
      "cannot be empty"
    );

    const blind = createCollection(
      {
        get: async () => undefined,
        set: async () => {},
        delete: async () => false,
        update: async () => undefined
      },
      "x"
    );
    await expect(blind.count()).rejects.toThrow("cannot enumerate");
  });

  it("pages through collections larger than one scan page", async () => {
    const store = new MemoryStore();
    const big = createCollection<number>(store, "big");
    for (let index = 0; index < 1_100; index += 1) {
      await big.put(String(index).padStart(5, "0"), index);
    }
    expect(await big.count()).toBe(1_100);
  });
});

describe("settings catalog", () => {
  it("records definitions of loaded plugins and forgets them on unload", async () => {
    const host = createPluginTestHost();
    await host.load(
      definePlugin({
        name: "configurable",
        version: "1.0.0",
        setup(context) {
          context.settings.define({ defaults: { enabled: true } });
          context.settings.define({ key: "extra", defaults: { n: 1 } });
        }
      })
    );
    expect(
      host.settings.list().map((entry) => `${entry.plugin}/${entry.key}`)
    ).toEqual(["configurable/default", "configurable/extra"]);
    expect(host.settings.find("configurable")?.defaults).toEqual({
      enabled: true
    });
    await host.unload("configurable");
    expect(host.settings.list()).toEqual([]);
  });
});
