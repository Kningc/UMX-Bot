import type { Logger } from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntervalScheduler } from "./scheduler.js";

class SchedulerTestLogger implements Logger {
  public warnings = 0;
  public debug(): void {}
  public info(): void {}
  public warn(): void {
    this.warnings += 1;
  }
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IntervalScheduler", () => {
  it("skips overlapping executions by default and aborts on dispose", async () => {
    vi.useFakeTimers();
    const logger = new SchedulerTestLogger();
    const scheduler = new IntervalScheduler(logger);
    let runs = 0;
    let aborted = false;

    const dispose = scheduler.every(
      "slow",
      1_000,
      (signal) =>
        new Promise<void>((resolve) => {
          runs += 1;
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          );
        }),
      { runImmediately: true }
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(1);
    expect(logger.warnings).toBe(1);

    await dispose();
    expect(aborted).toBe(true);
  });
});
