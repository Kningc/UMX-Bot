import { createPluginTestHost } from "@umx-bot/plugin-testkit";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("ping plugin", () => {
  it("replies to the command and to its alias", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();

    expect(
      (await host.receive("/ping")).map((message) => message.content)
    ).toEqual(["pong"]);
    expect(
      (await host.receive("/状态")).map((message) => message.content)
    ).toEqual(["pong"]);

    await host.stop();
  });

  it("stays silent for unrelated input", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();

    expect(await host.receive("ping")).toEqual([]);
    expect(await host.receive("/pingpong")).toEqual([]);

    await host.stop();
  });

  it("honours a custom command prefix", async () => {
    const host = createPluginTestHost({ commandPrefix: "!" });
    await host.load(plugin);
    await host.start();

    expect(
      (await host.receive("!ping")).map((message) => message.content)
    ).toEqual(["pong"]);
    expect(await host.receive("/ping")).toEqual([]);

    await host.stop();
  });

  it("registers one featured navigation item on every surface", async () => {
    const host = createPluginTestHost();
    await host.load(plugin);
    await host.start();

    const items = host
      .getNavigation()
      .flatMap((page) => page.items)
      .filter((item) => item.id === "ping");

    expect(items).toHaveLength(1);
    expect(items[0]?.featured).toBe(true);
    expect(items[0]?.surfaces).toEqual(["message", "menu"]);
    expect(items[0]?.scopes).toEqual(["direct", "group"]);

    await host.stop();
  });
});
