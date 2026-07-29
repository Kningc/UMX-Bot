import type { Logger } from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenManager } from "../token-manager.js";
import { QqOpenApiClient } from "./client.js";
import { QqApiError } from "./error.js";

class TestLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

function createClient() {
  let token = "token-1";
  const invalidate = vi.fn(() => {
    token = "token-2";
  });
  const tokenManager = {
    get: vi.fn(async () => token),
    invalidate
  } as unknown as TokenManager;
  return {
    invalidate,
    client: new QqOpenApiClient({
      baseUrl: "https://api.bot.qq.com",
      tokenManager,
      logger: new TestLogger(),
      timeoutMs: 1_000
    })
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QqOpenApiClient", () => {
  it("refreshes once for 401 but never retries permission-denied 403", async () => {
    const { client, invalidate } = createClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "sent" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ err_code: 112, message: "permission denied" }),
          { status: 403 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.request<{ id: string }>({
        method: "POST",
        path: "v2/users/u/messages",
        body: { content: "hello" }
      })
    ).resolves.toEqual({ id: "sent" });
    await expect(
      client.request({
        method: "POST",
        path: "v2/users/u/messages",
        body: { content: "hello" }
      })
    ).rejects.toMatchObject({
      name: "QqApiError",
      httpStatus: 403,
      kind: "permission",
      retryable: false
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves err_code, trace ID, retry-after and endpoint", async () => {
    const { client } = createClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ err_code: 22009, message: "too many requests" }),
          {
            status: 429,
            headers: {
              "retry-after": "2",
              "x-tps-trace-id": "trace-1"
            }
          }
        )
      )
    );

    const error = await client
      .request({
        method: "POST",
        path: "v2/groups/g/messages",
        body: {}
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(QqApiError);
    expect(error).toMatchObject({
      httpStatus: 429,
      errCode: 22009,
      traceId: "trace-1",
      endpoint: "POST /v2/groups/g/messages",
      retryable: true,
      kind: "rate_limit",
      retryAfterMs: 2_000
    });
  });

  it("treats a non-zero business code in an HTTP 200 body as an error", async () => {
    const { client } = createClient();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            err_code: 40054013,
            message: "用户拒收消息"
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      client.request({
        method: "POST",
        path: "v2/users/u/messages",
        body: {}
      })
    ).rejects.toMatchObject({
      httpStatus: 200,
      errCode: 40054013,
      kind: "delivery_rejected",
      retryable: false
    });
  });

  it.each([
    [400, "content violation", "content"],
    [400, "user rejected delivery", "delivery_rejected"],
    [400, "daily quota exhausted", "quota"],
    [500, "internal error", "transient"]
  ] as const)(
    "classifies HTTP %i business errors as %s/%s",
    async (status, message, kind) => {
      const { client } = createClient();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ err_code: 1, message }), { status })
        )
      );
      await expect(
        client.request({
          method: "POST",
          path: "v2/users/u/messages",
          body: {}
        })
      ).rejects.toMatchObject({
        kind,
        retryable: kind === "transient"
      });
    }
  );

  it("does not retry a definitive presigned-upload rejection", async () => {
    const { client } = createClient();
    const fetchMock = vi.fn(async () =>
      new Response("invalid signature", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.uploadBinary(
        "https://upload.example.com/part?signature=secret",
        new Uint8Array([1, 2, 3])
      )
    ).rejects.toMatchObject({
      httpStatus: 400,
      endpoint: "PUT presigned-upload",
      retryable: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
