import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
import { definePlugin } from "@qq-bot/plugin-sdk";
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
});
