// Minimal client for the UMX-Bot out-of-process plugin protocol
// (docs/remote-plugins.md). Zero dependencies: newline-delimited JSON-RPC 2.0
// on stdin/stdout. Never write anything but protocol lines to stdout; use
// stderr (or the `log` notification) for diagnostics.
import { createInterface } from "node:readline";

export function connect(identity) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });
  const on = (method, handler) => handlers.set(method, handler);

  // The host asks every child to stop this way; reply first, then exit.
  on("shutdown", () => {
    setImmediate(() => process.exit(0));
    return null;
  });

  createInterface({ input: process.stdin })
    .on("line", async (line) => {
      const message = JSON.parse(line);
      if (message.method === undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          waiter?.reject(
            Object.assign(new Error(message.error.message), {
              code: message.error.code
            })
          );
        } else {
          waiter?.resolve(message.result);
        }
        return;
      }
      const handler = handlers.get(message.method);
      if (message.id === undefined) {
        handler?.(message.params);
        return;
      }
      try {
        if (!handler) {
          throw Object.assign(new Error("method not found"), { code: -32601 });
        }
        send({
          id: message.id,
          result: (await handler(message.params)) ?? null
        });
      } catch (error) {
        send({
          id: message.id,
          error: { code: error.code ?? -32603, message: String(error.message) }
        });
      }
    })
    // The host closing our stdin means it is gone: never outlive it.
    .on("close", () => process.exit(0));

  return {
    request,
    notify,
    on,
    hello: () => request("hello", { protocol: 1.1, ...identity })
  };
}
