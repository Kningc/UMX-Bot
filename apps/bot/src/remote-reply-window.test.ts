import type { IncomingMessage } from "@umx-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ReplyWindow } from "./remote-reply-window.js";

function message(id: string, conversationId = "room"): IncomingMessage {
  return {
    id,
    platform: "test",
    scope: "group",
    conversationId,
    author: { id: "u", role: "member" },
    content: "",
    attachments: [],
    mentions: [],
    timestamp: new Date(0)
  };
}

describe("ReplyWindow", () => {
  it("keeps a quiet conversation's message while another one is busy", () => {
    const window = new ReplyWindow({ perConversation: 4, total: 100 });
    window.remember(message("quiet", "quiet-room"));
    for (let index = 0; index < 50; index += 1) {
      window.remember(message(`busy-${index}`, "busy-room"));
    }
    expect(window.get("quiet")?.id).toBe("quiet");
    expect(window.get("busy-0")).toBeUndefined();
    expect(window.get("busy-49")?.id).toBe("busy-49");
  });

  it("evicts the least recently used conversation at the overall cap", () => {
    const window = new ReplyWindow({ perConversation: 2, total: 4 });
    window.remember(message("a1", "a"));
    window.remember(message("b1", "b"));
    window.remember(message("c1", "c"));
    window.remember(message("a2", "a")); // touches a
    window.remember(message("d1", "d"));
    expect(window.size).toBe(4);
    expect(window.get("b1")).toBeUndefined();
    expect(window.get("a1")?.id).toBe("a1");
    expect(window.get("d1")?.id).toBe("d1");
  });

  it("expires entries after the time limit", () => {
    let now = 1000;
    const window = new ReplyWindow({ ttlMs: 100, now: () => now });
    window.remember(message("m"));
    now += 100;
    expect(window.get("m")?.id).toBe("m");
    now += 1;
    expect(window.get("m")).toBeUndefined();
    window.remember(message("m")); // re-delivery refreshes it
    expect(window.get("m")?.id).toBe("m");
    expect(window.size).toBe(1);
    expect(window.get("never")).toBeUndefined();
  });
});
