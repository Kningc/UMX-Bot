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

  it("injects platform events and rich incoming message fields", async () => {
    const host = createPluginTestHost();
    let contactId: string | undefined;
    let attachmentName: string | undefined;
    let quotedContent: string | undefined;
    let quoteReferenceId: string | undefined;
    await host.load(
      definePlugin({
        name: "events",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        setup(context) {
          context.events.on("contact.added", (event) => {
            contactId = event.userId;
          });
          context.events.on("message.created", (message) => {
            attachmentName = message.attachments[0]?.filename;
            quotedContent = message.quote?.content;
            quoteReferenceId = message.quote?.referenceId;
          });
        }
      })
    );
    await host.start();

    await host.emit("contact.added", {
      platform: "test",
      userId: "user-2",
      timestamp: new Date()
    });
    await host.receive("photo", {
      attachments: [
        {
          url: "https://example.com/photo.png",
          filename: "photo.png"
        }
      ],
      mentions: [{ id: "bot" }],
      quote: {
        content: "original message",
        referenceId: "message-original",
        attachments: []
      },
      botMentioned: true
    });

    expect(contactId).toBe("user-2");
    expect(attachmentName).toBe("photo.png");
    expect(quotedContent).toBe("original message");
    expect(quoteReferenceId).toBe("message-original");
    await host.stop();
  });

  it("supports adapter capability stubs", async () => {
    let recalledId: string | undefined;
    const host = createPluginTestHost({
      adapterCapabilities: {
        async recall(message) {
          recalledId = message.id;
        }
      }
    });
    await host.load(
      definePlugin({
        name: "recall",
        version: "1.0.0",
        setup(context) {
          context.commands.register({
            name: "recall",
            description: "reply and recall",
            async execute(command) {
              expect(context.messages.supports("recall")).toBe(true);
              const sent = await command.reply("temporary");
              await context.messages.recall(sent);
            }
          });
        }
      })
    );
    await host.start();

    await host.receive("/recall");

    expect(recalledId).toBe("sent-1");
    await host.stop();
  });
});
