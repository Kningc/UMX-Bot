import type { KeyValueStore } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { QqQuotaGovernor } from "./quota-governor.js";

class AtomicTestStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();
  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  public async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  public async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  public async update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    const next = updater(this.values.get(key) as T | undefined);
    if (next === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, next);
    }
    return next;
  }
}

describe("QqQuotaGovernor", () => {
  it("shares unverified bot QPS state across adapter instances", async () => {
    const store = new AtomicTestStore();
    const first = new QqQuotaGovernor("app", "unverified", store, () => 1_000);
    const second = new QqQuotaGovernor("app", "unverified", store, () => 1_000);
    for (let index = 0; index < 5; index += 1) {
      await (index % 2 === 0 ? first : second).consumeMessage({
        scope: "direct",
        conversationId: `user-${index}`,
        deliveryType: "active"
      });
    }
    await expect(
      second.consumeMessage({
        scope: "direct",
        conversationId: "user-last",
        deliveryType: "active"
      })
    ).rejects.toMatchObject({
      httpStatus: 429,
      kind: "rate_limit",
      retryAfterMs: 1_000
    });
  });

  it("enforces one wakeup in each official interaction cycle", async () => {
    let now = Date.UTC(2026, 6, 1);
    const governor = new QqQuotaGovernor(
      "app",
      "enterprise",
      new AtomicTestStore(),
      () => now
    );
    await governor.noteInteraction("user", new Date(now));
    await governor.consumeMessage({
      scope: "direct",
      conversationId: "user",
      deliveryType: "wakeup"
    });
    await expect(
      governor.consumeMessage({
        scope: "direct",
        conversationId: "user",
        deliveryType: "wakeup"
      })
    ).rejects.toMatchObject({ kind: "quota" });

    now += 2 * 24 * 60 * 60_000;
    await expect(
      governor.consumeMessage({
        scope: "direct",
        conversationId: "user",
        deliveryType: "wakeup"
      })
    ).resolves.toBeUndefined();
  });

  it("enforces relationship QPM and daily proactive-message limits", async () => {
    let now = 1_000;
    const minuteGovernor = new QqQuotaGovernor(
      "minute-app",
      "enterprise",
      new AtomicTestStore(),
      () => now
    );
    for (let index = 0; index < 20; index += 1) {
      await minuteGovernor.consumeMessage({
        scope: "direct",
        conversationId: "user",
        deliveryType: "active"
      });
      now += 101;
    }
    await expect(
      minuteGovernor.consumeMessage({
        scope: "direct",
        conversationId: "user",
        deliveryType: "active"
      })
    ).rejects.toMatchObject({ kind: "rate_limit" });

    now = 1_000;
    const dailyGovernor = new QqQuotaGovernor(
      "daily-app",
      "enterprise",
      new AtomicTestStore(),
      () => now
    );
    for (let index = 0; index < 1_000; index += 1) {
      await dailyGovernor.consumeMessage({
        scope: "direct",
        conversationId: "daily-user",
        deliveryType: "active"
      });
      now += 61_000;
    }
    await expect(
      dailyGovernor.consumeMessage({
        scope: "direct",
        conversationId: "daily-user",
        deliveryType: "active"
      })
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });
});
