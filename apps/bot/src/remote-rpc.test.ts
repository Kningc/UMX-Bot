import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, RPC_CODES, RpcError } from "./remote-rpc.js";

function createPeer(
  handlers: {
    request?: (method: string, params: unknown) => Promise<unknown>;
  } = {},
  maxLineLength?: number
) {
  const written: Record<string, unknown>[] = [];
  const invalid: string[] = [];
  const notifications: [string, unknown][] = [];
  const overflow = vi.fn();
  const peer = new JsonRpcPeer(
    {
      write: (line) => written.push(JSON.parse(line)),
      handleRequest:
        handlers.request ?? (async () => Promise.resolve("default")),
      handleNotification: (method, params) =>
        notifications.push([method, params]),
      onInvalidLine: (line) => invalid.push(line),
      onOverflow: overflow
    },
    maxLineLength
  );
  return { peer, written, invalid, notifications, overflow };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("JsonRpcPeer", () => {
  it("reassembles lines split across chunks and answers requests", async () => {
    const { peer, written } = createPeer({
      request: async (method, params) => ({ method, params })
    });
    peer.receive('{"jsonrpc":"2.0","id":7,"meth');
    peer.receive('od":"x","params":{"a":1}}\n');
    await tick();
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 7, result: { method: "x", params: { a: 1 } } }
    ]);
  });

  it("maps handler failures to JSON-RPC errors", async () => {
    const { peer, written } = createPeer({
      request: async (method) => {
        if (method === "typed") {
          throw new RpcError(RPC_CODES.permissionDenied, "no", { a: 1 });
        }
        throw new Error("boom");
      }
    });
    peer.receive('{"id":1,"method":"typed"}\n{"id":2,"method":"plain"}\n');
    await tick();
    expect(written).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "no", data: { a: 1 } }
      },
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "boom" } }
    ]);
  });

  it("resolves and rejects pending requests from responses", async () => {
    const { peer, written } = createPeer();
    const ok = peer.request("a", { x: 1 }, 1000);
    const bad = peer.request("b", undefined, 1000);
    expect(written.map((message) => message.id)).toEqual([1, 2]);
    peer.receive('{"id":1,"result":"fine"}\n');
    peer.receive('{"id":2,"error":{"code":-5,"message":"nope","data":1}}\n');
    await expect(ok).resolves.toBe("fine");
    await expect(bad).rejects.toMatchObject({ code: -5, message: "nope" });
  });

  it("tolerates malformed error objects", async () => {
    const { peer } = createPeer();
    const pending = peer.request("a", undefined, 1000);
    peer.receive('{"id":1,"error":{"code":"x"}}\n');
    await expect(pending).rejects.toMatchObject({
      code: RPC_CODES.internal,
      message: "remote error"
    });
  });

  it("times out requests", async () => {
    const { peer } = createPeer();
    await expect(peer.request("slow", {}, 10)).rejects.toMatchObject({
      code: RPC_CODES.timeout
    });
  });

  it("delivers notifications and reports stray lines", () => {
    const { peer, invalid, notifications } = createPeer();
    peer.receive(
      '{"method":"log","params":1}\nhello world\n[1]\n"str"\n{"id":99,"result":1}\n\n'
    );
    expect(notifications).toEqual([["log", 1]]);
    expect(invalid).toEqual([
      "hello world",
      "[1]",
      '"str"',
      '{"id":99,"result":1}'
    ]);
  });

  it("flags oversized lines", () => {
    const { peer, overflow } = createPeer({}, 8);
    peer.receive("123456789");
    expect(overflow).toHaveBeenCalledOnce();
  });

  it("fails pending and later requests once closed", async () => {
    const { peer, written } = createPeer();
    const pending = peer.request("a", {}, 1000);
    peer.close("gone");
    await expect(pending).rejects.toMatchObject({
      code: RPC_CODES.unavailable,
      message: "gone"
    });
    await expect(peer.request("b", {}, 1000)).rejects.toBeInstanceOf(RpcError);
    peer.notify("n", {});
    peer.receive('{"id":1,"result":1}\n');
    expect(written).toHaveLength(1);
  });
});
