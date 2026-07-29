import { createPluginTestHost } from "@qq-bot/plugin-testkit";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("starter plugin", () => {
  it("uses host configuration and replies through the real command runtime", async () => {
    const host = createPluginTestHost();
    await host.load(plugin, { config: { greeting: "欢迎" } });
    await host.start();

    const replies = await host.receive("/hello", { authorName: "小明" });

    expect(replies.map((message) => message.content)).toEqual([
      "欢迎，小明"
    ]);
    await host.stop();
  });
});
