import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
import { createServiceToken, definePlugin } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { BotKernel } from "./kernel.js";

class TestLogger implements Logger {
  public errors: unknown[] = [];

  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(data: unknown): void {
    this.errors.push(data);
  }
  public child(): Logger {
    return this;
  }
}

class TestAdapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  private onMessage?: (message: IncomingMessage) => Awaitable<void>;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }

  public async stop(): Promise<void> {}

  public async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  public async receive(
    content: string,
    role: IncomingMessage["author"]["role"] = "member"
  ): Promise<void> {
    await this.onMessage?.({
      id: `message-${content}`,
      platform: "test",
      scope: "group",
      conversationId: "group-1",
      author: { id: "user-1", role },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
  }
}

describe("BotKernel", () => {
  it("loads a plugin and routes a command reply", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "echo",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "echo",
            description: "echo arguments",
            async execute(command) {
              await command.reply(command.rawArgs);
            }
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/echo hello world");

    expect(adapter.sent).toEqual([
      {
        conversationId: "group-1",
        scope: "group",
        content: "hello world",
        replyTo: "message-/echo hello world"
      }
    ]);
    await bot.stop();
  });

  it("enforces command roles", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "admin",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "reload",
            description: "reload plugins",
            permission: "admin",
            execute: () => undefined
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/reload", "member");

    expect(adapter.sent[0]?.content).toBe("权限不足，无法执行该命令。");
    await bot.stop();
  });

  it("isolates failed event handlers from command routing", async () => {
    const adapter = new TestAdapter();
    const logger = new TestLogger();
    const bot = new BotKernel({ adapter, logger });
    await bot.load(
      definePlugin({
        name: "failure",
        version: "1.0.0",
        setup(context) {
          context.events.on("message.created", () => {
            throw new Error("expected failure");
          });
          context.commands.register({
            name: "ok",
            description: "still works",
            execute: (command) => command.reply("ok")
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/ok");

    expect(adapter.sent[0]?.content).toBe("ok");
    expect(logger.errors).toHaveLength(1);
    await bot.stop();
  });

  it("supports middleware short-circuiting", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "guard",
        version: "1.0.0",
        setup(context) {
          context.middleware.use(async (message, next) => {
            if (message.message.content.includes("blocked")) {
              message.handled = true;
              await message.reply("blocked by middleware");
              return;
            }
            await next();
          });
          context.commands.register({
            name: "blocked",
            description: "must not run",
            execute: (command) => command.reply("command ran")
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/blocked");

    expect(adapter.sent.map((message) => message.content)).toEqual([
      "blocked by middleware"
    ]);
    expect(bot.getHealth().metrics.commandsHandled).toBe(0);
    await bot.stop();
  });

  it("provides conversation-scoped settings and state to plugins", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "scoped",
        version: "1.0.0",
        async setup(context) {
          const settings = context.settings.define({
            defaults: { prefix: "visits" }
          });
          await settings.set(
            {
              level: "conversation",
              platform: "test",
              scope: "group",
              conversationId: "group-1"
            },
            { prefix: "group visits" }
          );
          context.commands.register({
            name: "visit",
            description: "count conversation visits",
            async execute(command) {
              const state = context.state.forConversation(command.message);
              const count = await state.update<number>(
                "count",
                (current) => (current ?? 0) + 1
              );
              const current = await settings.get(command.message);
              await command.reply(`${current.prefix}: ${count}`);
            }
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/visit");
    await adapter.receive("/visit");

    expect(adapter.sent.map((message) => message.content)).toEqual([
      "group visits: 1",
      "group visits: 2"
    ]);
    await bot.stop();
  });

  it("routes rich command replies without losing media", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "media",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "picture",
            description: "send a picture",
            execute: (command) =>
              command.reply({
                text: "picture",
                media: [
                  {
                    type: "image",
                    source: {
                      type: "url",
                      url: "https://example.com/picture.png"
                    }
                  }
                ]
              })
          });
        }
      })
    );

    await bot.start();
    await adapter.receive("/picture");

    expect(adapter.sent[0]).toEqual({
      conversationId: "group-1",
      scope: "group",
      replyTo: "message-/picture",
      content: {
        text: "picture",
        media: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/picture.png"
            }
          }
        ]
      }
    });
    await bot.stop();
  });

  it("parses quoted command arguments and enforces cooldowns", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      definePlugin({
        name: "parser",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "args",
            description: "show parsed args",
            cooldownMs: 10_000,
            execute: (command) =>
              command.reply(JSON.stringify(command.args))
          });
        }
      })
    );

    await bot.start();
    await adapter.receive(`/args "hello world" plain\\ value`);
    await adapter.receive("/args again");

    expect(adapter.sent.map((message) => message.content)).toEqual([
      `["hello world","plain value"]`,
      "命令冷却中，请在 10 秒后再试。"
    ]);
    await bot.stop();
  });

  it("validates plugin dependencies and shares typed services", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    const token = createServiceToken<{ answer: number }>("answer");
    let consumed = 0;
    let aborted = false;
    const consumer = definePlugin({
      name: "consumer",
      version: "1.0.0",
      dependencies: ["provider"],
      setup(context) {
        consumed = context.services.get(token).answer;
        context.signal.addEventListener("abort", () => {
          aborted = true;
        });
      }
    });

    await expect(bot.load(consumer)).rejects.toThrow("missing dependencies");
    await bot.load(
      definePlugin({
        name: "provider",
        version: "1.0.0",
        setup(context) {
          context.services.provide(token, { answer: 42 });
        }
      })
    );
    await bot.load(consumer);

    expect(consumed).toBe(42);
    expect(bot.getHealth().plugins.map((plugin) => plugin.name)).toEqual([
      "provider",
      "consumer"
    ]);
    await bot.start();
    await bot.stop();
    expect(aborted).toBe(true);
  });

  it("rolls back plugins when adapter startup fails", async () => {
    class FailingAdapter extends TestAdapter {
      public stopCalls = 0;
      public override async start(): Promise<void> {
        throw new Error("startup failed");
      }
      public override async stop(): Promise<void> {
        this.stopCalls += 1;
      }
    }

    const adapter = new FailingAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    let disposed = false;
    await bot.load(
      definePlugin({
        name: "lifecycle",
        version: "1.0.0",
        setup() {
          return () => {
            disposed = true;
          };
        }
      })
    );

    await expect(bot.start()).rejects.toThrow("startup failed");

    expect(adapter.stopCalls).toBe(1);
    expect(disposed).toBe(true);
    expect(bot.getHealth().state).toBe("failed");
    expect(bot.getHealth().plugins).toEqual([]);
  });

  it("reports runtime health metrics", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.start();
    await adapter.receive("regular message");

    const health = bot.getHealth();
    expect(health.state).toBe("running");
    expect(health.metrics).toEqual({
      received: 1,
      processed: 1,
      failed: 0,
      commandsHandled: 0
    });
    expect(health.startedAt).toBeInstanceOf(Date);
    await bot.stop();
    expect(bot.getHealth().state).toBe("stopped");
  });

  it("drains in-flight messages before unloading plugins", async () => {
    const adapter = new TestAdapter();
    const bot = new BotKernel({
      adapter,
      logger: new TestLogger(),
      shutdownTimeoutMs: 1_000
    });
    let releaseMessage: (() => void) | undefined;
    let enteredMiddleware = false;
    let pluginAborted = false;
    await bot.load(
      definePlugin({
        name: "drain",
        version: "1.0.0",
        setup(context) {
          context.signal.addEventListener("abort", () => {
            pluginAborted = true;
          });
          context.middleware.use(async (_message, next) => {
            enteredMiddleware = true;
            await new Promise<void>((resolve) => {
              releaseMessage = resolve;
            });
            await next();
          });
        }
      })
    );

    await bot.start();
    const receiving = adapter.receive("slow message");
    await Promise.resolve();
    expect(enteredMiddleware).toBe(true);

    let stopped = false;
    const stopping = bot.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(pluginAborted).toBe(false);

    releaseMessage?.();
    await receiving;
    await stopping;
    expect(pluginAborted).toBe(true);
  });

  it("can cancel an adapter that is still starting", async () => {
    class SlowStartAdapter implements BotAdapter {
      public readonly name = "slow";
      private rejectStart: ((error: Error) => void) | undefined;
      public stopCalls = 0;

      public start(): Promise<void> {
        return new Promise((_resolve, reject) => {
          this.rejectStart = reject;
        });
      }
      public async stop(): Promise<void> {
        this.stopCalls += 1;
        this.rejectStart?.(new Error("start cancelled"));
      }
      public async send(): Promise<void> {}
    }

    const adapter = new SlowStartAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    const starting = bot.start();
    await Promise.resolve();
    const stopping = bot.stop();

    await expect(starting).rejects.toThrow("start cancelled");
    await stopping;
    expect(adapter.stopCalls).toBeGreaterThanOrEqual(1);
    expect(bot.getHealth().state).toBe("stopped");
  });
});
