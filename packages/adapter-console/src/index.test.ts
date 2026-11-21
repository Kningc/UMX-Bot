import { Readable, Writable } from "node:stream";
import type { Logger } from "@qq-bot/plugin-sdk";
import { adapterConformanceChecks } from "@qq-bot/plugin-testkit";
import { describe, expect, it } from "vitest";
import { ConsoleAdapter } from "./index.js";

class TestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

describe("ConsoleAdapter send", () => {
  it("renders text and media descriptions", async () => {
    let output = "";
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const adapter = new ConsoleAdapter({
      logger: new TestLogger(),
      output: writable
    });

    await adapter.send({
      scope: "group",
      conversationId: "local",
      delivery: { type: "active", idempotencyKey: "console-test" },
      content: {
        text: "查看图片",
        media: [
          {
            type: "image",
            filename: "demo.png",
            source: { type: "url", url: "https://example.com/demo.png" }
          },
          {
            type: "file",
            source: { type: "data", data: new Uint8Array([1, 2, 3]) }
          }
        ]
      }
    });

    expect(output).toBe(
      [
        "机器人: 查看图片",
        "机器人 [image demo.png]: https://example.com/demo.png",
        "机器人 [file]: <3 bytes>",
        ""
      ].join("\n")
    );
  });
});

describe("ConsoleAdapter conformance", () => {
  const checks = adapterConformanceChecks({
    createAdapter: () =>
      new ConsoleAdapter({
        logger: new TestLogger(),
        // Detached streams keep the checks away from the real terminal.
        input: new Readable({ read() {} }),
        output: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          }
        })
      })
  });

  // The suite is the BotAdapter contract; every adapter has to satisfy it.
  for (const check of checks) {
    it(check.name, () => check.run());
  }
});
