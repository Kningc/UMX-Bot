import type { Logger } from "@qq-bot/plugin-sdk";
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
        return new Response("{}", { status: 200 });
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
      replyTo: "incoming-message"
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
        return new Response("{}", {
          status: messageRequests === 1 ? 401 : 200
        });
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
          : new Response("{}", { status: 200 });
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
      replyTo: "incoming",
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
        url: "https://api.sgroup.qq.com/v2/groups/group%2Fid/files",
        body: {
          file_type: 1,
          srv_send_msg: false,
          url: "https://example.com/picture.png"
        }
      },
      {
        url: "https://api.sgroup.qq.com/v2/groups/group%2Fid/messages",
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
          : new Response("{}", { status: 200 });
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
          : new Response("{}", { status: 200 });
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
      replyTo: "incoming",
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
});
