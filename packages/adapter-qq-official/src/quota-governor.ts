import type { ChatScope, KeyValueStore } from "@qq-bot/plugin-sdk";
import { QqApiError } from "./openapi/error.js";

export type QqCertification = "enterprise" | "personal" | "unverified";

interface Counter {
  window: number;
  count: number;
}

interface WakeupState {
  anchor: number;
  consumedCycles: number[];
}

interface QuotaState {
  counters: Record<string, Counter>;
  wakeups: Record<string, WakeupState>;
}

const emptyState = (): QuotaState => ({ counters: {}, wakeups: {} });

export class QqQuotaGovernor {
  private state = emptyState();
  private memoryQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly appId: string,
    private readonly certification: QqCertification,
    private readonly store?: KeyValueStore,
    private readonly now: () => number = Date.now
  ) {}

  public async noteInteraction(conversationId: string, at: Date): Promise<void> {
    await this.update((state) => {
      const previous = state.wakeups[conversationId];
      const anchor = at.getTime();
      if (!Number.isFinite(anchor)) {
        return;
      }
      if (!previous || anchor > previous.anchor) {
        state.wakeups[conversationId] = {
          anchor,
          consumedCycles: []
        };
      }
    });
  }

  public async consumeMessage(options: {
    scope: ChatScope;
    conversationId: string;
    deliveryType: "active" | "wakeup";
  }): Promise<void> {
    if (options.scope === "guild") {
      return;
    }
    const now = this.now();
    await this.update((state) => {
      if (options.deliveryType === "wakeup") {
        consumeWakeup(state, options.conversationId, now);
      }
      const botLimits =
        options.scope === "direct"
          ? this.certification === "unverified"
            ? [
                { name: "bot-second", durationMs: 1_000, limit: 5 },
                { name: "bot-minute", durationMs: 60_000, limit: 30 }
              ]
            : [{ name: "bot-second", durationMs: 1_000, limit: 10 }]
          : [
              {
                name: "bot-minute",
                durationMs: 60_000,
                limit: this.certification === "unverified" ? 30 : 60
              }
            ];
      for (const limit of botLimits) {
        consumeCounter(
          state,
          `${options.scope}:${limit.name}`,
          now,
          limit.durationMs,
          limit.limit
        );
      }
      const relation = `${options.scope}:${options.conversationId}`;
      consumeCounter(
        state,
        `${relation}:relation-minute`,
        now,
        60_000,
        20
      );
      consumeCounter(
        state,
        `${relation}:relation-day`,
        now,
        24 * 60 * 60_000,
        1_000
      );
    });
  }

  private async update(mutator: (state: QuotaState) => void): Promise<void> {
    if (this.store) {
      await this.store.update<QuotaState>(this.key(), (current) => {
        const state = current ?? emptyState();
        mutator(state);
        return state;
      });
      return;
    }
    const operation = this.memoryQueue.then(() => {
      const next = structuredClone(this.state);
      mutator(next);
      this.state = next;
    });
    this.memoryQueue = operation.catch(() => undefined);
    await operation;
  }

  private key(): string {
    return `adapter:qq-official:${this.appId}:quota`;
  }
}

function consumeCounter(
  state: QuotaState,
  key: string,
  now: number,
  durationMs: number,
  limit: number
): void {
  const window = Math.floor(now / durationMs);
  const current = state.counters[key];
  const count = current?.window === window ? current.count : 0;
  if (count >= limit) {
    const retryAfterMs = (window + 1) * durationMs - now;
    throw new QqApiError("QQ proactive message quota is exhausted", {
      httpStatus: 429,
      endpoint: "QUOTA",
      retryable: true,
      kind: "rate_limit",
      retryAfterMs
    });
  }
  state.counters[key] = { window, count: count + 1 };
}

function consumeWakeup(
  state: QuotaState,
  conversationId: string,
  now: number
): void {
  const wakeup = state.wakeups[conversationId];
  const day = 24 * 60 * 60_000;
  const age = wakeup ? now - wakeup.anchor : Number.POSITIVE_INFINITY;
  const cycle =
    age >= 0 && age < day
      ? 0
      : age < 3 * day
        ? 1
        : age < 7 * day
          ? 2
          : age < 30 * day
            ? 3
            : -1;
  if (!wakeup || cycle < 0 || wakeup.consumedCycles.includes(cycle)) {
    throw new QqApiError("QQ interaction wakeup quota is unavailable", {
      httpStatus: 429,
      endpoint: "WAKEUP_QUOTA",
      retryable: false,
      kind: "quota"
    });
  }
  wakeup.consumedCycles.push(cycle);
}
