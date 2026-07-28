import type { Awaitable, Dispose, Logger, Scheduler } from "@qq-bot/plugin-sdk";

export class IntervalScheduler implements Scheduler {
  public constructor(private readonly logger: Logger) {}

  public every(
    name: string,
    intervalMs: number,
    task: () => Awaitable<void>
  ): Dispose {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("scheduler interval must be a positive integer");
    }

    const timer = setInterval(() => {
      Promise.resolve(task()).catch((error: unknown) => {
        this.logger.error({ error, task: name }, "scheduled task failed");
      });
    }, intervalMs);
    timer.unref();

    return () => clearInterval(timer);
  }
}
