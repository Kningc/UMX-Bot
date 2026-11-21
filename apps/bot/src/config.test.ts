import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses the console adapter by default", () => {
    const config = loadConfig({});
    expect(config.BOT_ADAPTER).toBe("console");
    expect(config.QQ_SYNC_NAVIGATION).toBe(true);
  });

  it("can disable automatic QQ navigation synchronization", () => {
    expect(loadConfig({ QQ_SYNC_NAVIGATION: "false" }).QQ_SYNC_NAVIGATION).toBe(
      false
    );
  });

  it("caps code-reloading plugin reloads, 20 by default", () => {
    expect(loadConfig({}).BOT_PLUGIN_MAX_HOT_RELOADS).toBe(20);
    expect(
      loadConfig({ BOT_PLUGIN_MAX_HOT_RELOADS: "5" }).BOT_PLUGIN_MAX_HOT_RELOADS
    ).toBe(5);
    expect(() => loadConfig({ BOT_PLUGIN_MAX_HOT_RELOADS: "0" })).toThrow(
      "BOT_PLUGIN_MAX_HOT_RELOADS"
    );
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

  it("leaves the ops endpoint off unless a port is configured", () => {
    const config = loadConfig({});
    expect(config.BOT_METRICS_PORT).toBeUndefined();
    expect(config.BOT_METRICS_HOST).toBe("127.0.0.1");
  });

  it("accepts an ops endpoint port and host", () => {
    const config = loadConfig({
      BOT_METRICS_PORT: "9095",
      BOT_METRICS_HOST: "0.0.0.0"
    });
    expect(config.BOT_METRICS_PORT).toBe(9095);
    expect(config.BOT_METRICS_HOST).toBe("0.0.0.0");
  });

  it("rejects an out-of-range ops endpoint port", () => {
    expect(() => loadConfig({ BOT_METRICS_PORT: "70000" })).toThrow(
      "BOT_METRICS_PORT"
    );
    expect(() => loadConfig({ BOT_METRICS_PORT: "-1" })).toThrow(
      "BOT_METRICS_PORT"
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
