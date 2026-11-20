import type { Logger } from "@qq-bot/plugin-sdk";

export interface GatewayDispatcherOptions {
  /** Persists the highest sequence whose predecessors have all finished. */
  commit(sequence: number): Promise<void>;
  logger: Logger;
  onFinished?(outcome: "processed" | "failed", latencyMs: number): void;
}

/**
 * Runs Gateway dispatch events concurrently without losing resume safety.
 *
 * - Events in the same lane (one conversation, or all lifecycle events) run
 *   in arrival order; different lanes run in parallel, so a slow command in
 *   one chat no longer blocks other chats or Gateway heartbeats.
 * - The committed sequence only advances over a contiguous prefix of finished
 *   events, so a resume never skips an event that was still running.
 * - A failed handler is logged and counted as finished. Re-delivering it via
 *   resume would fail the same way and stall the whole Gateway.
 * - A task that reports `false` was abandoned (adapter stopping); its sequence
 *   is left uncommitted so the event is re-delivered after restart.
 *
 * One dispatcher belongs to one Gateway connection; `close()` it when the
 * connection is replaced so late completions cannot move progress backwards.
 */
export class GatewayDispatcher {
  private readonly pending: number[] = [];
  private readonly finished = new Set<number>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private commits: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(private readonly options: GatewayDispatcherOptions) {}

  public get inFlight(): number {
    return this.running.size;
  }

  public schedule(
    sequence: number | undefined,
    lane: string,
    task: () => Promise<boolean>
  ): void {
    if (sequence !== undefined) {
      this.pending.push(sequence);
    }
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const run = previous.then(async () => {
      // Tasks still run after close(): the event may never be re-delivered
      // (for example after an invalid session). Only their commit is skipped.
      const startedAt = Date.now();
      let completed: boolean;
      try {
        completed = await task();
        if (completed) {
          this.options.onFinished?.("processed", Date.now() - startedAt);
        }
      } catch (error) {
        completed = true;
        this.options.logger.error(
          { error, sequence, lane },
          "QQ gateway event processing failed; event dropped"
        );
        this.options.onFinished?.("failed", Date.now() - startedAt);
      }
      if (completed && sequence !== undefined) {
        this.finish(sequence);
      }
    });
    this.lanes.set(lane, run);
    this.running.add(run);
    void run.finally(() => {
      this.running.delete(run);
      if (this.lanes.get(lane) === run) {
        this.lanes.delete(lane);
      }
    });
  }

  /** Resolves once every scheduled event and pending commit has settled. */
  public async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
    await this.commits;
  }

  public close(): void {
    this.closed = true;
  }

  private finish(sequence: number): void {
    if (this.closed) {
      return;
    }
    this.finished.add(sequence);
    let committed: number | undefined;
    while (this.pending.length > 0 && this.finished.has(this.pending[0]!)) {
      committed = this.pending.shift()!;
      this.finished.delete(committed);
    }
    if (committed === undefined) {
      return;
    }
    const target = committed;
    this.commits = this.commits
      .then(() => (this.closed ? undefined : this.options.commit(target)))
      .catch((error: unknown) => {
        this.options.logger.error(
          { error, sequence: target },
          "QQ gateway progress could not be persisted"
        );
      });
  }
}
