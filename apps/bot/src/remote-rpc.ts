/**
 * Newline-delimited JSON-RPC 2.0 over a pair of byte streams. This is the wire
 * layer of the out-of-process plugin protocol (see docs/remote-plugins.md); it
 * knows nothing about plugins.
 */

export const RPC_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** The plugin used a power it was not granted. */
  permissionDenied: -32001,
  timeout: -32002,
  /** The peer is not ready, is restarting, or has gone away. */
  unavailable: -32003,
  /** The host does not implement what was asked for. */
  unsupported: -32004,
  /** The call belongs to a command that timed out or was cancelled. */
  cancelled: -32005
} as const;

export class RpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface JsonRpcPeerIo {
  /** Writes one already-serialised line (without the newline). */
  write(line: string): void;
  handleRequest(method: string, params: unknown): Promise<unknown>;
  handleNotification(method: string, params: unknown): void;
  /** A line that is not valid JSON-RPC. Usually stray output from the child. */
  onInvalidLine(line: string): void;
  /** The peer sent a line longer than the limit; the stream is unusable. */
  onOverflow(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

export class JsonRpcPeer {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  public constructor(
    private readonly io: JsonRpcPeerIo,
    private readonly maxLineLength = DEFAULT_MAX_LINE_LENGTH
  ) {}

  /** Feeds decoded text from the peer; lines may be split across chunks. */
  public receive(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxLineLength) {
      this.buffer = "";
      this.io.onOverflow();
    }
  }

  public request(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new RpcError(RPC_CODES.unavailable, `peer is closed (${method})`)
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcError(
            RPC_CODES.timeout,
            `"${method}" timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  public notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  /** Rejects everything in flight; later requests fail immediately. */
  public close(reason: string): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(RPC_CODES.unavailable, reason));
    }
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    this.io.write(JSON.stringify(message));
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.io.onInvalidLine(line);
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      this.io.onInvalidLine(line);
      return;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.method === "string") {
      if (record.id === undefined || record.id === null) {
        this.io.handleNotification(record.method, record.params);
      } else {
        void this.answer(record.id, record.method, record.params);
      }
      return;
    }
    if (typeof record.id === "number" && this.pending.has(record.id)) {
      this.settle(record.id, record);
      return;
    }
    this.io.onInvalidLine(line);
  }

  private settle(id: number, record: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = record.error;
    if (typeof error === "object" && error !== null) {
      const { code, message, data } = error as Record<string, unknown>;
      pending.reject(
        new RpcError(
          typeof code === "number" ? code : RPC_CODES.internal,
          typeof message === "string" ? message : "remote error",
          data
        )
      );
      return;
    }
    pending.resolve(record.result);
  }

  private async answer(
    id: unknown,
    method: string,
    params: unknown
  ): Promise<void> {
    try {
      const result = await this.io.handleRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(
              RPC_CODES.internal,
              error instanceof Error ? error.message : String(error)
            );
      this.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data !== undefined ? { data: rpc.data } : {})
        }
      });
    }
  }
}
