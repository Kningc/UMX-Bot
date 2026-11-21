import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  RecordingStore,
  SilentLogger
} from "../fixtures/listable-memory-store.js";
import type { QqOpenApiClient } from "../openapi/client.js";
import type { GatewayPayload } from "../protocol.js";
import type { TokenManager } from "../token-manager.js";
import { QqGatewayClient } from "./client.js";
import { QqGatewaySessionStore } from "./session-store.js";

const SESSION_KEY = "adapter:qq-official:app:gateway:0";

interface Internals {
  socket: unknown;
  stopped: boolean;
  sessionId: string | undefined;
  receivedSequence: number | null;
  processedSequence: number | null;
  awaitingHeartbeatAck: boolean;
  dispatcher: { idle(): Promise<void> };
  startHeartbeat(intervalMs: number): void;
  scheduleReconnect(): void;
  reconnectTimer?: NodeJS.Timeout;
  identifyOrResume(token: string): void;
  restoreSession(): Promise<void>;
  handleGatewayMessage(
    data: Buffer,
    token: string,
    markReady: () => void
  ): Promise<void>;
  enqueueGatewayMessage(
    data: Buffer,
    token: string,
    markReady: () => void
  ): Promise<void>;
}

function createClient(
  options: {
    store?: RecordingStore;
    onDispatch?: (payload: GatewayPayload) => Promise<void>;
  } = {}
): { client: QqGatewayClient; internal: Internals; store: RecordingStore } {
  const store = options.store ?? new RecordingStore();
  const client = new QqGatewayClient({
    // The transport is driven directly in these tests, so the HTTP client and
    // token manager are never reached.
    openApi: {} as QqOpenApiClient,
    tokens: {} as TokenManager,
    sessions: new QqGatewaySessionStore("app", store),
    logger: new SilentLogger(),
    intents: 1 << 25,
    readyTimeoutMs: 1_000,
    reconnectDelayMs: 2_000,
    reconnectMaxDelayMs: 60_000,
    onDispatch: options.onDispatch ?? (async () => undefined)
  });
  return {
    client,
    internal: client as unknown as Internals,
    store
  };
}

function messageDispatch(sequence: number, user: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      op: 0,
      s: sequence,
      id: `event-${sequence}`,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: `message-${sequence}`,
        content: "hello",
        author: { user_openid: user }
      }
    })
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QqGatewayClient heartbeat", () => {
  it("waits one interval before sending the first heartbeat", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const { client, internal } = createClient();
    internal.socket = {
      readyState: WebSocket.OPEN,
      send,
      terminate: vi.fn()
    };

    internal.startHeartbeat(1_000);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ op: 1, d: null }));

    (internal.socket as { readyState: number }).readyState = WebSocket.CLOSED;
    await client.stop();
  });
});

describe("QqGatewayClient reconnect", () => {
  it("keeps the process referenced while a reconnect is pending", async () => {
    const { client, internal } = createClient();
    internal.stopped = false;

    internal.scheduleReconnect();

    expect(internal.reconnectTimer?.hasRef()).toBe(true);
    await client.stop();
  });
});

describe("QqGatewayClient progress", () => {
  it("commits the watermark for an event whose handler failed", async () => {
    let calls = 0;
    const { internal, store } = createClient({
      onDispatch: async () => {
        calls += 1;
        throw new Error("injected handler failure");
      }
    });
    internal.sessionId = "session-1";
    internal.stopped = false;

    await internal.handleGatewayMessage(
      messageDispatch(42, "user-1"),
      "token",
      () => undefined
    );
    await internal.dispatcher.idle();

    // A failed event still advances progress, so a Resume cannot replay it
    // forever and wedge the Gateway.
    expect(calls).toBe(1);
    expect(internal.processedSequence).toBe(42);
    expect(store.values.get(SESSION_KEY)).toEqual({
      sessionId: "session-1",
      processedSequence: 42
    });
  });

  it("keeps heartbeats and other chats moving while one handler is slow", async () => {
    let releaseSlow!: () => void;
    const slowBlocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: string[] = [];
    const { internal, store } = createClient({
      onDispatch: async (payload) => {
        const id = (payload.d as { id: string }).id;
        started.push(id);
        if (id === "message-42") {
          await slowBlocked;
        }
      }
    });
    internal.sessionId = "session-1";
    internal.stopped = false;
    const enqueue = (data: Buffer) =>
      internal.enqueueGatewayMessage(data, "token", () => undefined);

    await enqueue(messageDispatch(42, "slow-user"));
    await enqueue(messageDispatch(43, "other-user"));
    await enqueue(messageDispatch(44, "slow-user"));
    internal.awaitingHeartbeatAck = true;
    await enqueue(Buffer.from(JSON.stringify({ op: 11 })));
    await vi.waitFor(() => expect(started).toContain("message-43"));

    // The ACK is not stuck behind the slow handler.
    expect(internal.awaitingHeartbeatAck).toBe(false);
    // Same-chat ordering is preserved: 44 waits for 42.
    expect(started).toEqual(["message-42", "message-43"]);
    // 43 finished, but 42 has not, so progress must not skip past 42.
    expect(internal.processedSequence).toBeNull();

    releaseSlow();
    await internal.dispatcher.idle();
    expect(started).toEqual(["message-42", "message-43", "message-44"]);
    expect(internal.processedSequence).toBe(44);
    const persisted = store.writes.map(
      ({ value }) => (value as { processedSequence: number }).processedSequence
    );
    expect(persisted.at(-1)).toBe(44);
    expect([...persisted].sort((x, y) => x - y)).toEqual(persisted);
  });

  it("leaves events queued behind a stopping client uncommitted", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const { internal } = createClient({
      onDispatch: async (payload) => {
        started.push((payload.d as { id: string }).id);
        await blocked;
      }
    });
    internal.sessionId = "session-1";
    internal.stopped = false;

    for (const sequence of [7, 8]) {
      await internal.handleGatewayMessage(
        messageDispatch(sequence, "user-1"),
        "token",
        () => undefined
      );
    }
    await vi.waitFor(() => expect(started).toEqual(["message-7"]));
    internal.stopped = true;
    release();
    await internal.dispatcher.idle();

    expect(started).toEqual(["message-7"]);
    expect(internal.processedSequence).toBe(7);
  });
});

describe("QqGatewayClient session", () => {
  it("restores a persisted session and resumes from the processed sequence", async () => {
    const store = new RecordingStore();
    await store.set(SESSION_KEY, {
      sessionId: "persisted-session",
      processedSequence: 17
    });
    const send = vi.fn();
    const { internal } = createClient({ store });
    internal.socket = { readyState: WebSocket.OPEN, send };

    await internal.restoreSession();
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

  it("identifies instead of resuming without a stored session", async () => {
    const send = vi.fn();
    const { internal } = createClient();
    internal.socket = { readyState: WebSocket.OPEN, send };

    await internal.restoreSession();
    internal.identifyOrResume("token");

    const payload = JSON.parse(String(send.mock.calls[0]?.[0]));
    expect(payload.op).toBe(2);
    expect(payload.d.token).toBe("QQBot token");
    expect(payload.d.shard).toEqual([0, 1]);
  });

  it("clears persisted progress when the gateway rejects a session", async () => {
    const store = new RecordingStore();
    await store.set(SESSION_KEY, {
      sessionId: "expired-session",
      processedSequence: 17
    });
    const close = vi.fn();
    const { internal } = createClient({ store });
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

  it("rejects a hello without a usable heartbeat interval", async () => {
    const { internal } = createClient();
    internal.socket = { readyState: WebSocket.OPEN, send: vi.fn() };

    await expect(
      internal.handleGatewayMessage(
        Buffer.from(JSON.stringify({ op: 10, d: {} })),
        "token",
        () => undefined
      )
    ).rejects.toThrow(/heartbeat interval/u);
  });
});
