import { createServiceToken } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ServiceContainer } from "./service-container.js";

describe("ServiceContainer", () => {
  it("shares typed services and removes them with their provider", async () => {
    const token = createServiceToken<{ value: number }>("counter");
    const container = new ServiceContainer();
    const provider = container.forPlugin("provider");
    const consumer = container.forPlugin("consumer");

    const dispose = provider.provide(token, { value: 42 });
    expect(consumer.has(token)).toBe(true);
    expect(consumer.get(token).value).toBe(42);

    await dispose();
    expect(consumer.has(token)).toBe(false);
    expect(() => consumer.get(token)).toThrow("not available");
  });

  it("prevents multiple providers for one token", () => {
    const token = createServiceToken<string>("unique");
    const container = new ServiceContainer();
    container.forPlugin("first").provide(token, "one");

    expect(() =>
      container.forPlugin("second").provide(token, "two")
    ).toThrow("already provided");
  });
});
