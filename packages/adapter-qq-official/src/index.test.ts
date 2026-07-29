import type {
  Awaitable,
  BotEvents,
  IncomingMessage,
  KeyValueStore,
  Logger
} from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { QqOfficialAdapter } from "./index.js";

class AdapterTestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class TestStore implements KeyValueStore {
  public readonly values = new Map<string, unknown>();
  public readonly writes: Array<{ key: string; value: unknown }> = [];
  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  public async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    this.writes.push({ key, value });
  }
  public async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  public async update<T>(
    key: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    const next = updater(this.values.get(key) as T | undefined);
    if (next === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, next);
    }
    return next;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QqOfficialAdapter send", () => {
  it("increments reply sequence for repeated replies", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const message = {
      scope: "group" as const,
      conversationId: "group",
      content: "reply",
      delivery: {
        type: "passive" as const,
        target: { type: "message" as const, messageId: "incoming-message" }
      }
    };
    await adapter.send(message);
    await adapter.send(message);

    expect(requestBodies.map((body) => body.msg_seq)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes credentials once after an unauthorized response", async () => {
    let tokenRequests = 0;
    let messageRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request) => {
        if (String(input).includes("getAppAccessToken")) {
          tokenRequests += 1;
          return new Response(
            JSON.stringify({
              access_token: `token-${tokenRequests}`,
              expires_in: 7200
            }),
            { status: 200 }
          );
        }
        messageRequests += 1;
        return new Response(
          messageRequests === 1
            ? "{}"
            : JSON.stringify({ id: "sent" }),
          {
          status: messageRequests === 1 ? 401 : 200
          }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: { type: "active", idempotencyKey: "unauthorized-test" },
      content: "hello"
    });

    expect(tokenRequests).toBe(2);
    expect(messageRequests).toBe(2);
  });

  it("uploads an image URL and sends a rich reply", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url, body });
        return url.endsWith("/files")
          ? new Response(JSON.stringify({ file_info: "uploaded-image" }), {
              status: 200
            })
          : new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "group",
      conversationId: "group/id",
      delivery: {
        type: "passive",
        target: { type: "message", messageId: "incoming" }
      },
      content: {
        text: "图片说明",
        media: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/picture.png"
            }
          }
        ]
      }
    });

    expect(requests).toEqual([
      {
        url: "https://api.bot.qq.com/v2/groups/group%2Fid/files",
        body: {
          file_type: 1,
          srv_send_msg: false,
          url: "https://example.com/picture.png"
        }
      },
      {
        url: "https://api.bot.qq.com/v2/groups/group%2Fid/messages",
        body: {
          msg_type: 7,
          content: "图片说明",
          media: { file_info: "uploaded-image" },
          msg_id: "incoming",
          msg_seq: 1
        }
      }
    ]);
  });

  it("uploads binary media as base64", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return url.endsWith("/files")
          ? new Response(JSON.stringify({ file_info: "voice-info" }), {
              status: 200
            })
          : new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: { type: "active", idempotencyKey: "audio-test" },
      content: {
        media: [
          {
            type: "audio",
            filename: "hello.wav",
            source: {
              type: "data",
              data: new Uint8Array([1, 2, 3])
            }
          }
        ]
      }
    });

    expect(requestBodies).toEqual([
      {
        file_type: 3,
        srv_send_msg: false,
        file_name: "hello.wav",
        file_data: "AQID"
      },
      {
        msg_type: 7,
        content: "",
        media: { file_info: "voice-info" }
      }
    ]);
  });

  it("sends text separately before non-image media", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return url.endsWith("/files")
          ? new Response(JSON.stringify({ file_info: "video-info" }), {
              status: 200
            })
          : new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "group",
      conversationId: "group",
      delivery: {
        type: "passive",
        target: { type: "message", messageId: "incoming" }
      },
      content: {
        text: "演示视频",
        media: [
          {
            type: "video",
            source: { type: "url", url: "https://example.com/demo.mp4" }
          }
        ]
      }
    });

    expect(requestBodies).toEqual([
      {
        msg_type: 0,
        content: "演示视频",
        msg_id: "incoming",
        msg_seq: 1
      },
      {
        file_type: 2,
        srv_send_msg: false,
        url: "https://example.com/demo.mp4"
      },
      {
        msg_type: 7,
        content: "",
        media: { file_info: "video-info" },
        msg_id: "incoming",
        msg_seq: 2
      }
    ]);
  });

  it("sends markdown navigation with command buttons", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "group",
      conversationId: "group",
      delivery: {
        type: "passive",
        target: { type: "message", messageId: "incoming" }
      },
      content: {
        markdown: "# 导航\n请选择操作",
        keyboard: {
          rows: [
            [
              {
                id: "ping",
                label: "在线状态",
                action: "command",
                data: "/ping",
                style: 1
              }
            ]
          ]
        }
      }
    });

    expect(requestBodies).toEqual([
      {
        msg_type: 2,
        markdown: { content: "# 导航\n请选择操作" },
        keyboard: {
          content: {
            rows: [
              {
                buttons: [
                  {
                    id: "ping",
                    render_data: {
                      label: "在线状态",
                      visited_label: "在线状态",
                      style: 1
                    },
                    action: {
                      type: 2,
                      permission: { type: 2 },
                      data: "/ping",
                      enter: true,
                      reply: false,
                      unsupport_tips: "请手动发送 /ping"
                    }
                  }
                ]
              }
            ]
          }
        },
        msg_id: "incoming",
        msg_seq: 1
      }
    ]);
  });

  it("serializes link/callback actions and template keyboards", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const delivery = {
      type: "passive" as const,
      target: { type: "message" as const, messageId: "incoming" }
    };

    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery,
      content: {
        markdown: "actions",
        keyboard: {
          rows: [
            [
              {
                label: "打开",
                action: "link",
                url: "https://example.com",
                style: 2
              },
              {
                label: "回调",
                action: "callback",
                data: "callback-data",
                style: 3
              }
            ]
          ]
        }
      }
    });
    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery,
      content: {
        markdown: "template",
        keyboard: { templateId: "keyboard-template" }
      }
    });

    expect(bodies[0]).toMatchObject({
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  render_data: { style: 2 },
                  action: {
                    type: 0,
                    data: "https://example.com"
                  }
                },
                {
                  render_data: { style: 3 },
                  action: {
                    type: 1,
                    data: "callback-data"
                  }
                }
              ]
            }
          ]
        }
      }
    });
    expect(bodies[1]).toMatchObject({
      keyboard: { id: "keyboard-template" }
    });
  });

  it("falls back to markdown when custom buttons are unavailable", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let messageRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requestBodies.push(JSON.parse(String(init?.body)));
        messageRequests += 1;
        return new Response(
          messageRequests === 1
            ? "keyboard permission denied"
            : JSON.stringify({ id: "sent" }),
          { status: messageRequests === 1 ? 400 : 200 }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: {
        type: "passive",
        target: { type: "message", messageId: "incoming" }
      },
      content: {
        markdown: "# 导航",
        keyboard: {
          rows: [[{ label: "帮助", action: "command", data: "/help" }]]
        }
      }
    });

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toHaveProperty("keyboard");
    expect(requestBodies[1]).not.toHaveProperty("keyboard");
    expect(requestBodies[1]).toMatchObject({
      msg_type: 2,
      markdown: { content: "# 导航" },
      msg_id: "incoming",
      msg_seq: 2
    });
  });

  it("rejects unsafe media protocols before making requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await expect(
      adapter.send({
        scope: "group",
        conversationId: "group",
        delivery: { type: "active", idempotencyKey: "unsafe-media-test" },
        content: {
          media: [
            {
              type: "image",
              source: { type: "url", url: "file:///etc/passwd" }
            }
          ]
        }
      })
    ).rejects.toThrow("must use HTTP or HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns receipts and reuses the outbox result for active messages", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            id: "qq-message-1",
            timestamp: "2026-07-29T00:00:00.000Z",
            ext_info: { audit: "ok" }
          }),
          { status: 200 }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const outgoing = {
      scope: "direct" as const,
      conversationId: "user",
      delivery: {
        type: "active" as const,
        idempotencyKey: "notification-1"
      },
      content: "hello"
    };

    const first = await adapter.send(outgoing);
    const second = await adapter.send(outgoing);

    expect(first).toMatchObject({
      platform: "qq-official",
      scope: "direct",
      conversationId: "user",
      id: "qq-message-1"
    });
    expect(first.timestamp.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(
      adapter.getOutboxStatus("notification-1")
    ).resolves.toBe("sent");
  });

  it("keeps uncertain active sends pending and refuses blind resends", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        throw new TypeError("connection reset after request");
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const outgoing = {
      scope: "direct" as const,
      conversationId: "user",
      delivery: {
        type: "active" as const,
        idempotencyKey: "uncertain-1"
      },
      content: "hello"
    };

    await expect(adapter.send(outgoing)).rejects.toMatchObject({
      httpStatus: 0,
      retryable: true
    });
    await expect(adapter.send(outgoing)).rejects.toThrow(
      "refusing an automatic resend"
    );
    await expect(
      adapter.getOutboxStatus("uncertain-1")
    ).resolves.toBe("uncertain");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains an uncertain outbox record when sent receipt persistence fails", async () => {
    class FailingSentStore extends TestStore {
      public override async set<T>(key: string, value: T): Promise<void> {
        if (
          key.includes(":outbox:") &&
          (value as { status?: string }).status === "sent"
        ) {
          throw new Error("injected SQLite write failure");
        }
        await super.set(key, value);
      }
    }
    const store = new FailingSentStore();
    const fetchMock = vi.fn(
      async (input: string | URL | Request) =>
        String(input).includes("getAppAccessToken")
          ? new Response(
              JSON.stringify({ access_token: "token", expires_in: 7200 }),
              { status: 200 }
            )
          : new Response(JSON.stringify({ id: "qq-message-1" }), {
              status: 200
            })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const outgoing = {
      scope: "direct" as const,
      conversationId: "user",
      delivery: {
        type: "active" as const,
        idempotencyKey: "sent-store-failure"
      },
      content: "hello"
    };

    await expect(adapter.send(outgoing)).rejects.toThrow(
      "injected SQLite write failure"
    );
    await expect(
      adapter.getOutboxStatus("sent-store-failure")
    ).resolves.toBe("uncertain");
    await expect(adapter.send(outgoing)).rejects.toThrow(
      "refusing an automatic resend"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains uncertain outbox state after a multi-message partial success", async () => {
    let messageRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        if (url.endsWith("/files")) {
          return new Response(JSON.stringify({ file_info: "audio-file" }), {
            status: 200
          });
        }
        messageRequests += 1;
        return messageRequests === 1
          ? new Response(JSON.stringify({ id: "text-sent" }), { status: 200 })
          : new Response(
              JSON.stringify({ err_code: 400, message: "media rejected" }),
              { status: 400 }
            );
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const outgoing = {
      scope: "direct" as const,
      conversationId: "user",
      delivery: {
        type: "active" as const,
        idempotencyKey: "partial-rich"
      },
      content: {
        text: "first",
        media: [
          {
            type: "audio" as const,
            source: { type: "url" as const, url: "https://example.com/a.silk" }
          }
        ] as const
      }
    };

    await expect(adapter.send(outgoing)).rejects.toMatchObject({
      httpStatus: 400
    });
    await expect(adapter.getOutboxStatus("partial-rich")).resolves.toBe(
      "uncertain"
    );
    await expect(adapter.send(outgoing)).rejects.toThrow(
      "refusing an automatic resend"
    );
    expect(messageRequests).toBe(2);
  });

  it("serializes event replies, references and wakeup delivery distinctly", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: `sent-${bodies.length}` }), {
          status: 200
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    await (
      adapter as unknown as {
        quota: { noteInteraction(id: string, at: Date): Promise<void> };
      }
    ).quota.noteInteraction("user", new Date());

    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: {
        type: "passive",
        target: { type: "event", eventId: "event-1" }
      },
      reference: {
        messageId: "quoted-message",
        ignoreGetMessageError: true
      },
      content: "event reply"
    });
    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: { type: "wakeup", idempotencyKey: "wakeup-1" },
      content: "come back"
    });

    expect(bodies).toEqual([
      {
        msg_type: 0,
        content: "event reply",
        message_reference: {
          message_id: "quoted-message",
          ignore_get_message_error: true
        },
        event_id: "event-1"
      },
      {
        msg_type: 0,
        content: "come back",
        is_wakeup: true
      }
    ]);
  });

  it("routes recall and typing requests without exposing credentials", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      body: unknown;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        requests.push({
          url: String(input),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return init?.method === "DELETE"
          ? new Response(undefined, { status: 204 })
          : new Response(JSON.stringify({ id: "typing" }), { status: 200 });
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    await adapter.recall({
      platform: "qq-official",
      scope: "group",
      conversationId: "group/id",
      id: "message/id",
      timestamp: new Date()
    });
    await adapter.setTyping(
      {
        platform: "qq-official",
        scope: "direct",
        conversationId: "user"
      },
      30,
      { type: "message", messageId: "incoming" }
    );

    expect(requests).toEqual([
      {
        url: "https://api.bot.qq.com/v2/groups/group%2Fid/messages/message%2Fid",
        method: "DELETE",
        body: undefined
      },
      {
        url: "https://api.bot.qq.com/v2/users/user/messages",
        method: "POST",
        body: {
          msg_type: 6,
          input_notify: {
            input_type: 1,
            input_second: 30
          },
          msg_id: "incoming",
          msg_seq: 1
        }
      }
    ]);
  });

  it("manages append, replace and completion for direct-message streams", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: "stream-1",
            timestamp: "2026-07-29T00:00:00.000Z"
          }),
          { status: 200 }
        );
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });

    const stream = await adapter.openMessageStream({
      conversation: {
        platform: "qq-official",
        scope: "direct",
        conversationId: "user"
      },
      delivery: {
        type: "passive",
        target: { type: "message", messageId: "incoming" }
      },
      contentType: "markdown",
      initialContent: "A",
      inputMode: "replace"
    });
    await stream.append(" B");
    await stream.replace("A B C");
    await stream.complete();

    expect(stream.id).toBe("stream-1");
    expect(stream.index).toBe(4);
    expect(stream.state).toBe("completed");
    expect(bodies).toEqual([
      {
        input_mode: "replace",
        input_state: 1,
        index: 0,
        content_type: "markdown",
        content_raw: "A",
        msg_id: "incoming",
        msg_seq: 1
      },
      {
        input_mode: "append",
        input_state: 1,
        index: 1,
        content_type: "markdown",
        content_raw: " B",
        stream_msg_id: "stream-1",
        msg_id: "incoming",
        msg_seq: 1
      },
      {
        input_mode: "replace",
        input_state: 1,
        index: 2,
        content_type: "markdown",
        content_raw: "A B C",
        stream_msg_id: "stream-1",
        msg_id: "incoming",
        msg_seq: 1
      },
      {
        input_mode: "replace",
        input_state: 10,
        index: 3,
        content_type: "markdown",
        content_raw: "A B C",
        stream_msg_id: "stream-1",
        msg_id: "incoming",
        msg_seq: 1
      }
    ]);
  });

  it("marks a stream uncertain after a rejected chunk and requires recovery", async () => {
    let chunks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        chunks += 1;
        return chunks === 1
          ? new Response(JSON.stringify({ id: "stream-1" }), { status: 200 })
          : new Response(
              JSON.stringify({
                err_code: 40007,
                message: "已下发内容前缀不可修改"
              }),
              { status: 400 }
            );
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const stream = await adapter.openMessageStream({
      conversation: {
        platform: "qq-official",
        scope: "direct",
        conversationId: "user"
      },
      delivery: {
        type: "passive",
        target: { type: "event", eventId: "event-1" }
      },
      contentType: "text",
      initialContent: "prefix"
    });

    await expect(stream.replace("changed")).rejects.toMatchObject({
      errCode: 40007
    });
    expect(stream.state).toBe("uncertain");
    await expect(stream.complete("fallback")).rejects.toThrow(
      "message stream is uncertain"
    );
    await expect(stream.retry()).rejects.toMatchObject({ errCode: 40007 });
    expect(chunks).toBe(3);
  });

  it("persists active stream progress and explicitly retries an uncertain chunk", async () => {
    const store = new TestStore();
    const bodies: Array<Record<string, unknown>> = [];
    let chunks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        chunks += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (chunks === 2) {
          throw new TypeError("connection reset after stream chunk");
        }
        return new Response(JSON.stringify({ id: "stream-1" }), {
          status: 200
        });
      })
    );
    const options = {
      conversation: {
        platform: "qq-official",
        scope: "direct" as const,
        conversationId: "user"
      },
      delivery: {
        type: "active" as const,
        idempotencyKey: "stream-job-1"
      },
      contentType: "text" as const,
      initialContent: "A"
    };
    const firstAdapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const first = await firstAdapter.openMessageStream(options);
    await expect(first.append("B")).rejects.toMatchObject({ httpStatus: 0 });
    expect(first.state).toBe("uncertain");
    await expect(
      firstAdapter.getOutboxStatus("stream-job-1")
    ).resolves.toBe("uncertain");

    const restartedAdapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const restored = await restartedAdapter.openMessageStream(options);
    expect(restored.state).toBe("uncertain");
    expect(restored.index).toBe(1);
    await restored.retry();
    await restored.abort("done");

    expect(restored.state).toBe("aborted");
    await expect(
      restartedAdapter.getOutboxStatus("stream-job-1")
    ).resolves.toBe("sent");
    expect(bodies.map((body) => body.index)).toEqual([0, 1, 1, 2]);
    expect(bodies.slice(1, 3).map((body) => body.stream_msg_id)).toEqual([
      "stream-1",
      "stream-1"
    ]);
  });

  it("uploads large local media in ordered parts and reuses unexpired file_info", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      body?: Record<string, unknown>;
      bytes?: number;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        if (url.startsWith("https://upload.example.com/")) {
          requests.push({
            url,
            method: init?.method,
            bytes: (init?.body as Uint8Array).byteLength
          });
          return new Response("", { status: 200 });
        }
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        requests.push({
          url,
          method: init?.method,
          ...(body ? { body } : {})
        });
        if (url.endsWith("/upload_prepare")) {
          return new Response(
            JSON.stringify({
              upload_id: "upload-1",
              block_size: String(3 * 1024 * 1024),
              parts: [
                {
                  index: 0,
                  presigned_url: "https://upload.example.com/part-0",
                  block_size: String(3 * 1024 * 1024)
                },
                {
                  index: 1,
                  presigned_url: "https://upload.example.com/part-1",
                  block_size: String(3 * 1024 * 1024)
                }
              ],
              upload_config: { concurrency: 1 }
            }),
            { status: 200 }
          );
        }
        if (url.endsWith("/files")) {
          return new Response(
            JSON.stringify({ file_info: "large-file", ttl: 300 }),
            { status: 200 }
          );
        }
        if (url.endsWith("/messages")) {
          return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      })
    );
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const media = {
      type: "file" as const,
      filename: "large.bin",
      source: {
        type: "data" as const,
        data: new Uint8Array(6 * 1024 * 1024)
      }
    };

    await adapter.send({
      scope: "group",
      conversationId: "group",
      delivery: { type: "active", idempotencyKey: "large-1" },
      content: { media: [media] }
    });
    await adapter.send({
      scope: "group",
      conversationId: "group",
      delivery: { type: "active", idempotencyKey: "large-2" },
      content: { media: [media] }
    });

    expect(
      requests.map((request) => ({
        path: new URL(request.url).pathname,
        method: request.method,
        bytes: request.bytes
      }))
    ).toEqual([
      {
        path: "/v2/groups/group/upload_prepare",
        method: "POST",
        bytes: undefined
      },
      {
        path: "/part-0",
        method: "PUT",
        bytes: 3 * 1024 * 1024
      },
      {
        path: "/v2/groups/group/upload_part_finish",
        method: "POST",
        bytes: undefined
      },
      {
        path: "/part-1",
        method: "PUT",
        bytes: 3 * 1024 * 1024
      },
      {
        path: "/v2/groups/group/upload_part_finish",
        method: "POST",
        bytes: undefined
      },
      {
        path: "/v2/groups/group/files",
        method: "POST",
        bytes: undefined
      },
      {
        path: "/v2/groups/group/messages",
        method: "POST",
        bytes: undefined
      },
      {
        path: "/v2/groups/group/messages",
        method: "POST",
        bytes: undefined
      }
    ]);
  });

  it("uploads async media sources while buffering only one requested part", async () => {
    const uploadedSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "token", expires_in: 7200 }),
            { status: 200 }
          );
        }
        if (url.endsWith("/upload_prepare")) {
          return new Response(
            JSON.stringify({
              upload_id: "stream-upload",
              parts: [
                {
                  index: 0,
                  block_size: "4",
                  presigned_url: "https://upload.example.com/0"
                },
                {
                  index: 1,
                  block_size: "2",
                  presigned_url: "https://upload.example.com/1"
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (url.startsWith("https://upload.example.com/")) {
          uploadedSizes.push((init?.body as Uint8Array).byteLength);
          return new Response("", { status: 200 });
        }
        if (url.endsWith("/files")) {
          return new Response(JSON.stringify({ file_info: "stream-file" }), {
            status: 200
          });
        }
        if (url.endsWith("/messages")) {
          return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      })
    );
    async function* source(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
      yield new Uint8Array([6]);
    }
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    await adapter.send({
      scope: "direct",
      conversationId: "user",
      delivery: { type: "active", idempotencyKey: "stream-media" },
      content: {
        media: [
          {
            type: "file",
            source: {
              type: "stream",
              stream: source(),
              size: 6,
              md5: "0".repeat(32),
              sha1: "1".repeat(40),
              md5_10m: "2".repeat(32)
            }
          }
        ]
      }
    });

    expect(uploadedSizes).toEqual([4, 2]);
  });
});

describe("QqOfficialAdapter gateway lifecycle", () => {
  it("waits one interval before sending the first heartbeat", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const internal = adapter as unknown as {
      socket: {
        readyState: number;
        send(payload: string): void;
        terminate(): void;
      };
      startHeartbeat(intervalMs: number): void;
    };
    internal.socket = {
      readyState: WebSocket.OPEN,
      send,
      terminate: vi.fn()
    };

    internal.startHeartbeat(1_000);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ op: 1, d: null }));

    internal.socket.readyState = WebSocket.CLOSED;
    await adapter.stop();
  });

  it("keeps the process referenced while a reconnect is pending", async () => {
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const internal = adapter as unknown as {
      stopped: boolean;
      reconnectTimer?: NodeJS.Timeout;
      scheduleReconnect(): void;
    };
    internal.stopped = false;

    internal.scheduleReconnect();

    expect(internal.reconnectTimer?.hasRef()).toBe(true);
    await adapter.stop();
  });

  it("commits gateway progress only after message processing succeeds", async () => {
    const store = new TestStore();
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const internal = adapter as unknown as {
      sessionId?: string;
      processedSequence: number | null;
      onMessage?: (message: IncomingMessage) => Awaitable<void>;
      handleGatewayMessage(
        data: Buffer,
        token: string,
        markReady: () => void
      ): Promise<void>;
    };
    internal.sessionId = "session-1";
    internal.onMessage = async () => {
      throw new Error("injected handler failure");
    };
    const payload = Buffer.from(
      JSON.stringify({
        op: 0,
        s: 42,
        id: "event-42",
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "message-1",
          content: "hello",
          author: { user_openid: "user-1" }
        }
      })
    );

    await expect(
      internal.handleGatewayMessage(payload, "token", () => undefined)
    ).rejects.toThrow("injected handler failure");
    expect(internal.processedSequence).toBeNull();
    expect(
      store.values.get("adapter:qq-official:app:gateway:0")
    ).toBeUndefined();

    internal.onMessage = async () => undefined;
    await internal.handleGatewayMessage(payload, "token", () => undefined);
    expect(internal.processedSequence).toBe(42);
    expect(store.values.get("adapter:qq-official:app:gateway:0")).toEqual({
      sessionId: "session-1",
      processedSequence: 42
    });
  });

  it("serializes gateway dispatches so persisted sequence cannot move backwards", async () => {
    const store = new TestStore();
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const started: string[] = [];
    const internal = adapter as unknown as {
      sessionId?: string;
      onMessage?: (message: IncomingMessage) => Awaitable<void>;
      enqueueGatewayMessage(
        data: Buffer,
        token: string,
        markReady: () => void
      ): Promise<void>;
    };
    internal.sessionId = "session-1";
    internal.onMessage = async (message) => {
      started.push(message.id);
      if (message.id === "message-42") {
        markFirstStarted();
        await firstBlocked;
      }
    };
    const dispatch = (sequence: number) =>
      Buffer.from(
        JSON.stringify({
          op: 0,
          s: sequence,
          id: `event-${sequence}`,
          t: "C2C_MESSAGE_CREATE",
          d: {
            id: `message-${sequence}`,
            content: "hello",
            author: { user_openid: "user-1" }
          }
        })
      );

    const first = internal.enqueueGatewayMessage(
      dispatch(42),
      "token",
      () => undefined
    );
    const second = internal.enqueueGatewayMessage(
      dispatch(43),
      "token",
      () => undefined
    );
    await firstStarted;
    expect(started).toEqual(["message-42"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(started).toEqual(["message-42", "message-43"]);
    expect(
      store.writes.map(
        ({ value }) => (value as { processedSequence: number }).processedSequence
      )
    ).toEqual([42, 43]);
  });

  it("restores a persisted session and resumes from processed sequence", async () => {
    const store = new TestStore();
    await store.set("adapter:qq-official:app:gateway:0", {
      sessionId: "persisted-session",
      processedSequence: 17
    });
    const send = vi.fn();
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const internal = adapter as unknown as {
      socket: { readyState: number; send(payload: string): void };
      restoreGatewayState(): Promise<void>;
      identifyOrResume(token: string): void;
    };
    internal.socket = { readyState: WebSocket.OPEN, send };

    await internal.restoreGatewayState();
    internal.identifyOrResume("token");

    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual({
      op: 6,
      d: {
        token: "QQBot token",
        session_id: "persisted-session",
        seq: 17
      }
    });
  });

  it("clears persisted progress when the gateway rejects a session", async () => {
    const store = new TestStore();
    await store.set("adapter:qq-official:app:gateway:0", {
      sessionId: "expired-session",
      processedSequence: 17
    });
    const close = vi.fn();
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const internal = adapter as unknown as {
      socket: { close(code: number, reason: string): void };
      sessionId?: string;
      receivedSequence: number | null;
      processedSequence: number | null;
      handleGatewayMessage(
        data: Buffer,
        token: string,
        markReady: () => void
      ): Promise<void>;
    };
    internal.socket = { close };
    internal.sessionId = "expired-session";
    internal.receivedSequence = 17;
    internal.processedSequence = 17;

    await internal.handleGatewayMessage(
      Buffer.from(JSON.stringify({ op: 9 })),
      "token",
      () => undefined
    );

    expect(internal.sessionId).toBeUndefined();
    expect(internal.receivedSequence).toBeNull();
    expect(internal.processedSequence).toBeNull();
    expect(store.values.size).toBe(0);
    expect(close).toHaveBeenCalledWith(4001, "invalid session");
  });

  it("maps lifecycle events and preserves event_id", async () => {
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger()
    });
    const events: Array<{ event: string; payload: unknown }> = [];
    const internal = adapter as unknown as {
      onEvent?: <K extends Exclude<keyof BotEvents, "message.created">>(
        event: K,
        payload: BotEvents[K]
      ) => Awaitable<void>;
      handleDispatch(payload: {
        op: number;
        id?: string;
        s?: number;
        t?: string;
        d?: unknown;
      }): Promise<void>;
    };
    internal.onEvent = async (event, payload) => {
      events.push({ event, payload });
    };

    await internal.handleDispatch({
      op: 0,
      id: "event-friend",
      s: 9,
      t: "FRIEND_ADD",
      d: { openid: "user-1", timestamp: 1_700_000_000 }
    });
    await internal.handleDispatch({
      op: 0,
      id: "event-unknown",
      s: 10,
      t: "NEW_QQ_EVENT",
      d: { value: true }
    });

    expect(events[0]).toMatchObject({
      event: "contact.added",
      payload: {
        platform: "qq-official",
        userId: "user-1",
        eventId: "event-friend"
      }
    });
    expect(events[1]).toMatchObject({
      event: "platform.event",
      payload: {
        type: "NEW_QQ_EVENT",
        eventId: "event-unknown",
        sequence: 10
      }
    });
  });

  it("persists delivery rejection and blocks later active sends locally", async () => {
    const store = new TestStore();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new QqOfficialAdapter({
      appId: "app",
      clientSecret: "secret",
      logger: new AdapterTestLogger(),
      gatewayStateStore: store
    });
    const internal = adapter as unknown as {
      handleDispatch(payload: {
        op: number;
        id?: string;
        s?: number;
        t?: string;
        d?: unknown;
      }): Promise<void>;
    };
    await internal.handleDispatch({
      op: 0,
      t: "GROUP_MSG_REJECT",
      d: { group_openid: "group-1" }
    });

    await expect(
      adapter.send({
        scope: "group",
        conversationId: "group-1",
        delivery: { type: "active", idempotencyKey: "blocked-1" },
        content: "hello"
      })
    ).rejects.toMatchObject({
      kind: "delivery_rejected",
      retryable: false
    });
    await expect(
      adapter.getDeliveryStatus({
        platform: "qq-official",
        scope: "group",
        conversationId: "group-1"
      })
    ).resolves.toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
