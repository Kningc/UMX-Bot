// Example out-of-process plugin: `node examples/remote-echo/plugin.mjs`.
// Register it in plugins.json with a `remote` entry (see docs/remote-plugins.md).
import { connect } from "./client.mjs";

const bot = connect({
  name: "remote-echo",
  version: "1.0.0",
  apiVersion: 2,
  description: "Example plugin running in its own process",
  permissions: []
});

bot.on("initialize", async () => {
  await bot.request("commands.register", {
    name: "echo",
    description: "Echo text back",
    usage: "<text>",
    fallback: true,
    subcommands: [
      {
        name: "upper",
        description: "Echo in upper case",
        // Validated by the host before the child is called (protocol 1.1).
        args: { text: { type: "string", rest: true } }
      },
      { name: "count", description: "How many times echo count ran" }
    ]
  });
  await bot.request("events.subscribe", { event: "message.created" });
});

bot.on("event", async ({ event }) => {
  if (event === "message.created") {
    await bot.request("metrics.counter.inc", {
      name: "messages_seen",
      help: "Messages seen by the echo plugin"
    });
  }
});

bot.on("command.execute", async ({ subcommand, rawArgs, parsed }) => {
  if (subcommand === "upper") {
    return { reply: parsed.text.toUpperCase() };
  }
  if (subcommand === "count") {
    // Optimistic update: retry until our compare-and-set wins.
    for (;;) {
      const count = (await bot.request("store.get", { key: "count" })) ?? 0;
      const { swapped } = await bot.request("store.compareAndSet", {
        key: "count",
        expected: count === 0 ? null : count,
        value: count + 1
      });
      if (swapped) {
        return { reply: `echo count: ${count + 1}` };
      }
    }
  }
  return { reply: rawArgs || "(nothing to echo)" };
});

await bot.hello();
