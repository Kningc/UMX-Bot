import type {
  Awaitable,
  Dispose,
  Logger,
  ScheduleOptions,
  Scheduler
} from "@qq-bot/plugin-sdk";

export class IntervalScheduler implements Scheduler {
  public constructor(private readonly logger: Logger) {}

  public every(
    name: string,
    intervalMs: number,
    task: (signal: AbortSignal) => Awaitable<void>,
    options: ScheduleOptions = {}
  ): Dispose {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("scheduler interval must be a positive integer");
    }

    const controller = new AbortController();
    const running = new Set<Promise<void>>();
    let disposed = false;
    const overlap = options.overlap ?? "skip";

    const invoke = (): void => {
      if (disposed || controller.signal.aborted) {
        return;
      }
      if (overlap === "skip" && running.size > 0) {
        this.logger.warn({ task: name }, "scheduled task overlap skipped");
        return;
      }

      const execution = Promise.resolve()
        .then(() => task(controller.signal))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            this.logger.error({ error, task: name }, "scheduled task failed");
          }
        })
        .finally(() => {
          running.delete(execution);
        });
      running.add(execution);
    };

    const timer = setInterval(invoke, intervalMs);
    timer.unref();

    if (options.runImmediately) {
      queueMicrotask(invoke);
    }

    return async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(timer);
      controller.abort();
      await Promise.allSettled([...running]);
    };
  }
}
