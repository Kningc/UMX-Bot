import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses the console adapter by default", () => {
    expect(loadConfig({}).BOT_ADAPTER).toBe("console");
  });

  it("requires credentials for the QQ adapter", () => {
    expect(() => loadConfig({ BOT_ADAPTER: "qq-official" })).toThrow(
      "QQ_APP_ID"
    );
  });
});
