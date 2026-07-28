import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token-manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TokenManager", () => {
  it("coalesces concurrent refreshes", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "token-1", expires_in: "7200" }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = new TokenManager("app", "secret", "https://token", 1_000);

    const values = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);

    expect(values).toEqual(["token-1", "token-1", "token-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes an invalidated token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "token-1", expires_in: 7200 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "token-2", expires_in: 7200 }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = new TokenManager("app", "secret", "https://token", 1_000);

    expect(await tokens.get()).toBe("token-1");
    tokens.invalidate("token-1");
    expect(await tokens.get()).toBe("token-2");
  });
});
