import type { Logger } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";

class EventTestLogger implements Logger {
  public errors = 0;
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {
    this.errors += 1;
  }
  public child(): Logger {
    return this;
  }
}

describe("EventBus", () => {
  it("invokes handlers by priority and preserves registration order", async () => {
    const calls: string[] = [];
    const bus = new EventBus(new EventTestLogger());
    bus.on("bot.ready", () => {
      calls.push("normal-first");
    });
    bus.on(
      "bot.ready",
      () => {
        calls.push("high");
      },
      { priority: 10 }
    );
    bus.on("bot.ready", () => {
      calls.push("normal-second");
    });

    await bus.emit("bot.ready", { adapter: "test" });

    expect(calls).toEqual(["high", "normal-first", "normal-second"]);
  });

  it("runs once subscriptions once across repeated emissions", async () => {
    let calls = 0;
    const bus = new EventBus(new EventTestLogger());
    bus.on("bot.ready", () => {
      calls += 1;
    }, { once: true });

    await bus.emit("bot.ready", { adapter: "test" });
    await bus.emit("bot.ready", { adapter: "test" });

    expect(calls).toBe(1);
  });

  it("isolates synchronous handler failures", async () => {
    const logger = new EventTestLogger();
    const bus = new EventBus(logger);
    let healthyHandlerCalled = false;
    bus.on("bot.ready", () => {
      throw new Error("boom");
    });
    bus.on("bot.ready", () => {
      healthyHandlerCalled = true;
    });

    await bus.emit("bot.ready", { adapter: "test" });

    expect(healthyHandlerCalled).toBe(true);
    expect(logger.errors).toBe(1);
  });
});
