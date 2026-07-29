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

  it("rejects invalid timeout configuration", () => {
    expect(() => loadConfig({ BOT_SHUTDOWN_TIMEOUT_MS: "0" })).toThrow(
      "BOT_SHUTDOWN_TIMEOUT_MS"
    );
  });

  it("accepts an explicit plugin manifest path", () => {
    expect(
      loadConfig({ BOT_PLUGIN_MANIFEST: "/etc/qq-bot/plugins.json" })
        .BOT_PLUGIN_MANIFEST
    ).toBe("/etc/qq-bot/plugins.json");
    expect(() => loadConfig({ BOT_PLUGIN_MANIFEST: "" })).toThrow(
      "BOT_PLUGIN_MANIFEST"
    );
  });
});
