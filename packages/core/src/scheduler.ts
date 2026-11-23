import type {
  Awaitable,
  CronOptions,
  Dispose,
  KeyValueStore,
  Logger,
  ScheduleOptions,
  Scheduler
} from "@umx-bot/plugin-sdk";
import { CronSchedule } from "./cron.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ScheduledRunOutcome = "ok" | "error" | "skipped";

export interface IntervalSchedulerOptions {
  /** Persists the last cron run so `catchUp` survives a restart. */
  store?: KeyValueStore;
  /** Called after every run attempt, for metrics. */
  onRun?: (
    task: string,
    outcome: ScheduledRunOutcome,
    durationMs: number
  ) => void;
}

type Task = (signal: AbortSignal) => Awaitable<void>;

export class IntervalScheduler implements Scheduler {
  public constructor(
    private readonly logger: Logger,
    private readonly options: IntervalSchedulerOptions = {}
  ) {}

  public every(
    name: string,
    intervalMs: number,
    task: Task,
    options: ScheduleOptions = {}
  ): Dispose {
    // Node clamps delays above 2^31-1 ms to 1 ms, which would turn a long
    // interval into a busy loop.
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs <= 0 ||
      intervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(
        `scheduler interval must be an integer from 1 to ${MAX_TIMER_DELAY_MS} ms`
      );
    }

    const runner = this.runner(name, task, options.overlap ?? "skip");
    const timer = setInterval(runner.invoke, intervalMs);
    timer.unref();

    if (options.runImmediately) {
      queueMicrotask(runner.invoke);
    }

    return async () => {
      clearInterval(timer);
      await runner.stop();
    };
  }

  public cron(
    name: string,
    expression: string,
    task: Task,
    options: CronOptions = {}
  ): Dispose {
    const schedule = CronSchedule.parse(expression);
    const timezone = options.timezone ?? "local";
    const runner = this.runner(name, task, options.overlap ?? "skip");
    const stateKey = `scheduler:cron:${name}`;
    const store = options.catchUp ? this.options.store : undefined;
    let timer: NodeJS.Timeout | undefined;
    let disposed = false;

    const record = (): void => {
      void store
        ?.set(stateKey, new Date().toISOString())
        .catch((error: unknown) => {
          this.logger.warn(
            { error, task: name },
            "scheduler state write failed"
          );
        });
    };

    const arm = (): void => {
      if (disposed) {
        return;
      }
      const target = schedule.next(new Date(), timezone);
      if (!target) {
        this.logger.warn({ task: name, expression }, "cron has no future run");
        return;
      }
      const delay = target.getTime() - Date.now();
      timer = setTimeout(
        () => {
          // A clamped delay wakes up early; re-evaluate instead of firing.
          if (Date.now() < target.getTime()) {
            arm();
            return;
          }
          record();
          runner.invoke();
          arm();
        },
        Math.min(Math.max(delay, 0), MAX_TIMER_DELAY_MS)
      );
      timer.unref();
    };

    arm();

    if (store) {
      void store
        .get<string>(stateKey)
        .then((lastRun) => {
          if (disposed) {
            return;
          }
          if (lastRun === undefined) {
            // First time seen: nothing was missed, start the clock now.
            record();
            return;
          }
          const missed = schedule.next(new Date(lastRun), timezone);
          if (missed && missed.getTime() <= Date.now()) {
            this.logger.info({ task: name }, "cron catching up a missed run");
            record();
            runner.invoke();
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { error, task: name },
            "scheduler state read failed"
          );
        });
    }

    return async () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      await runner.stop();
    };
  }

  public at(name: string, when: Date, task: Task): Dispose {
    if (Number.isNaN(when.getTime())) {
      throw new Error("scheduler time is not a valid date");
    }
    const runner = this.runner(name, task, "allow");
    let timer: NodeJS.Timeout | undefined;
    let disposed = false;

    const arm = (): void => {
      if (disposed) {
        return;
      }
      const remaining = when.getTime() - Date.now();
      if (remaining > MAX_TIMER_DELAY_MS) {
        timer = setTimeout(arm, MAX_TIMER_DELAY_MS);
      } else {
        timer = setTimeout(runner.invoke, Math.max(remaining, 0));
      }
      timer.unref();
    };
    arm();

    return async () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      await runner.stop();
    };
  }

  private runner(
    name: string,
    task: Task,
    overlap: "skip" | "allow"
  ): { invoke: () => void; stop: () => Promise<void> } {
    const controller = new AbortController();
    const running = new Set<Promise<void>>();
    let stopped = false;

    const invoke = (): void => {
      if (stopped || controller.signal.aborted) {
        return;
      }
      if (overlap === "skip" && running.size > 0) {
        this.logger.warn({ task: name }, "scheduled task overlap skipped");
        this.options.onRun?.(name, "skipped", 0);
        return;
      }

      const startedAt = performance.now();
      let outcome: ScheduledRunOutcome = "ok";
      const execution = Promise.resolve()
        .then(() => task(controller.signal))
        .catch((error: unknown) => {
          outcome = "error";
          if (!controller.signal.aborted) {
            this.logger.error({ error, task: name }, "scheduled task failed");
          }
        })
        .finally(() => {
          running.delete(execution);
          this.options.onRun?.(name, outcome, performance.now() - startedAt);
        });
      running.add(execution);
    };

    return {
      invoke,
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        controller.abort();
        await Promise.allSettled([...running]);
      }
    };
  }
}
