import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createPluginTestHost } from "./index.js";

describe("PluginTestHost", () => {
  it("loads a plugin and captures command replies", async () => {
    const host = createPluginTestHost({ commandPrefix: "!" });
    await host.load(
      definePlugin({
        name: "hello",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        setup(context) {
          context.commands.register({
            name: "hello",
            description: "say hello",
            execute: (command) => command.reply("hello")
          });
        }
      })
    );
    await host.start();

    const replies = await host.receive("!hello");

    expect(replies.map((message) => message.content)).toEqual(["hello"]);
    await host.stop();
  });
});
