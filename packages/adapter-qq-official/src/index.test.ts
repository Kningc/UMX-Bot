import type { Logger } from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
