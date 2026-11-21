import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import {
  RecordingStore,
  SilentLogger
} from "../fixtures/listable-memory-store.js";
import type { QqOpenApiClient } from "../openapi/client.js";
import type { GatewayPayload } from "../protocol.js";
import type { TokenManager } from "../token-manager.js";
import { QqGatewayClient } from "./client.js";
import { describeIntents, resolveIntents } from "./intents.js";
import { QqGatewaySessionStore } from "./session-store.js";

// End-to-end tests of the socket lifecycle against a real local WebSocket
// server playing the QQ Gateway: Identify/Resume, heartbeats, server-driven
// reconnects, invalid sessions and the failure paths of the first connect.

const INTENTS = 1 << 25;
const SESSION_KEY = "adapter:qq-official:app:gateway:0";
const HEARTBEAT_MS = 40;

type Conversation = (socket: WebSocket, index: number) => void;

class FakeGateway {
  public readonly server: WebSocketServer;
  /** Payloads the client sent, per connection. */
  public readonly received: GatewayPayload[][] = [];
  public readonly closeCodes: number[] = [];
  private conversation: Conversation = (socket) => helloThenReady(socket);

  public constructor() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.server.on("connection", (socket) => {
      const index = this.received.length;
      const inbox: GatewayPayload[] = [];
      this.received.push(inbox);
      socket.on("message", (data) => {
        inbox.push(JSON.parse(data.toString()) as GatewayPayload);
      });
      socket.on("close", (code) => {
        this.closeCodes[index] = code;
      });
      this.conversation(socket, index);
    });
  }

  public static async listen(): Promise<FakeGateway> {
    const gateway = new FakeGateway();
    if (gateway.server.address() === null) {
      await new Promise((resolve) => gateway.server.once("listening", resolve));
    }
    return gateway;
  }

  public get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public script(conversation: Conversation): void {
    this.conversation = conversation;
  }

  /** First message of each op the client sent on a connection. */
  public sent(index: number, op: number): GatewayPayload | undefined {
    return this.received[index]?.find((payload) => payload.op === op);
  }

  public close(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate();
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function send(socket: WebSocket, payload: GatewayPayload): void {
  socket.send(JSON.stringify(payload));
}

/** Answers Identify with READY and Resume with RESUMED; ACKs heartbeats. */
function helloThenReady(
  socket: WebSocket,
  options: { ack?: boolean; sessionId?: string } = {}
): void {
  send(socket, { op: 10, d: { heartbeat_interval: HEARTBEAT_MS } });
  socket.on("message", (data) => {
    const payload = JSON.parse(data.toString()) as GatewayPayload;
    if (payload.op === 2) {
      send(socket, {
        op: 0,
        s: 1,
        t: "READY",
        d: { session_id: options.sessionId ?? "session-1" }
      });
    } else if (payload.op === 6) {
      send(socket, { op: 0, s: 2, t: "RESUMED", d: {} });
    } else if (payload.op === 1 && options.ack !== false) {
      send(socket, { op: 11 });
    }
  });
}

let gateway: FakeGateway;
let client: QqGatewayClient | undefined;

function createClient(
  options: {
    store?: RecordingStore;
    url?: string | undefined;
    readyTimeoutMs?: number;
    onDispatch?: (payload: GatewayPayload) => Promise<void>;
  } = {}
) {
  const store = options.store ?? new RecordingStore();
  const logger = new SilentLogger();
  const url = "url" in options ? options.url : gateway.url;
  client = new QqGatewayClient({
    openApi: {
      request: async () => ({ url })
    } as unknown as QqOpenApiClient,
    tokens: { get: async () => "access-token" } as unknown as TokenManager,
    sessions: new QqGatewaySessionStore("app", store, INTENTS),
    logger,
    intents: INTENTS,
    readyTimeoutMs: options.readyTimeoutMs ?? 1_000,
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 20,
    onDispatch: options.onDispatch ?? (async () => undefined)
  });
  return { client, store };
}

afterEach(async () => {
  await client?.stop();
  client = undefined;
  await gateway?.close();
});

describe("QqGatewayClient connection lifecycle", () => {
  it("identifies with the configured intents and becomes ready", async () => {
    gateway = await FakeGateway.listen();
    const { client, store } = createClient();

    await client.start();

    expect(client.isReady).toBe(true);
    expect(gateway.sent(0, 2)).toMatchObject({
      op: 2,
      d: { token: "QQBot access-token", intents: INTENTS, shard: [0, 1] }
    });
    expect(store.values.get(SESSION_KEY)).toEqual({
      sessionId: "session-1",
      processedSequence: 1,
      intents: INTENTS
    });
  });

  it("delivers dispatches and commits their sequence", async () => {
    gateway = await FakeGateway.listen();
    const delivered: GatewayPayload[] = [];
    const { client, store } = createClient({
      onDispatch: async (payload) => {
        delivered.push(payload);
      }
    });
    await client.start();

    const [socket] = gateway.server.clients;
    send(socket as WebSocket, {
      op: 0,
      s: 5,
      t: "C2C_MESSAGE_CREATE",
      d: { id: "m-5", content: "hi", author: { user_openid: "u-1" } }
    });

    await vi.waitFor(() =>
      expect(client.diagnostics().processedSequence).toBe(5)
    );
    expect(delivered.map((payload) => payload.s)).toEqual([5]);
    expect(
      (store.values.get(SESSION_KEY) as { processedSequence: number })
        .processedSequence
    ).toBe(5);
  });

  it("answers a server heartbeat request immediately", async () => {
    gateway = await FakeGateway.listen();
    const { client } = createClient();
    await client.start();

    const [socket] = gateway.server.clients;
    const before = gateway.received[0]?.filter((p) => p.op === 1).length ?? 0;
    send(socket as WebSocket, { op: 1 });

    await vi.waitFor(() =>
      expect(
        gateway.received[0]?.filter((p) => p.op === 1).length
      ).toBeGreaterThan(before)
    );
  });

  it("reconnects and resumes when heartbeat ACKs stop arriving", async () => {
    gateway = await FakeGateway.listen();
    gateway.script((socket, index) =>
      helloThenReady(socket, { ack: index > 0 })
    );
    const { client } = createClient();
    await client.start();

    // No ACK on the first connection: the next beat terminates the socket.
    await vi.waitFor(() => expect(gateway.received.length).toBe(2), {
      timeout: 2_000
    });
    await vi.waitFor(() => expect(client.isReady).toBe(true));

    expect(gateway.sent(1, 6)).toEqual({
      op: 6,
      d: { token: "QQBot access-token", session_id: "session-1", seq: 1 }
    });
    expect(gateway.sent(1, 2)).toBeUndefined();
    const diagnostics = client.diagnostics();
    expect(diagnostics.reconnects).toBeGreaterThanOrEqual(1);
    expect(diagnostics.resumeAttempts).toBe(1);
    expect(diagnostics.resumeSuccesses).toBe(1);
  });

  it("reconnects with Resume when the server asks for a reconnect", async () => {
    gateway = await FakeGateway.listen();
    const { client } = createClient();
    await client.start();

    const [socket] = gateway.server.clients;
    send(socket as WebSocket, { op: 7 });

    await vi.waitFor(() => expect(gateway.sent(1, 6)).toBeDefined());
    expect(gateway.closeCodes[0]).toBe(4000);
    await vi.waitFor(() => expect(client.isReady).toBe(true));
  });

  it("forgets the session and identifies afresh after Invalid Session", async () => {
    gateway = await FakeGateway.listen();
    const { client, store } = createClient();
    gateway.script((socket, index) =>
      helloThenReady(socket, { sessionId: `session-${index + 1}` })
    );
    await client.start();

    const [socket] = gateway.server.clients;
    send(socket as WebSocket, { op: 9 });

    await vi.waitFor(() => expect(gateway.sent(1, 2)).toBeDefined());
    expect(gateway.closeCodes[0]).toBe(4001);
    expect(gateway.sent(1, 6)).toBeUndefined();
    await vi.waitFor(() =>
      expect(store.values.get(SESSION_KEY)).toEqual({
        sessionId: "session-2",
        processedSequence: 1,
        intents: INTENTS
      })
    );
  });

  it("resumes a session persisted by a previous process", async () => {
    gateway = await FakeGateway.listen();
    const store = new RecordingStore();
    await store.set(SESSION_KEY, {
      sessionId: "persisted",
      processedSequence: 41,
      intents: INTENTS
    });
    const { client } = createClient({ store });

    await client.start();

    expect(gateway.sent(0, 6)).toEqual({
      op: 6,
      d: { token: "QQBot access-token", session_id: "persisted", seq: 41 }
    });
    expect(client.diagnostics().restoredSessions).toBe(1);
  });

  it("does not reconnect after stop()", async () => {
    gateway = await FakeGateway.listen();
    const { client } = createClient();
    await client.start();

    await client.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(gateway.received.length).toBe(1);
    expect(gateway.closeCodes[0]).toBe(1000);
    expect(client.isStopped).toBe(true);
  });
});

describe("QqGatewayClient first connect failures", () => {
  it("fails start() when the gateway never becomes ready", async () => {
    gateway = await FakeGateway.listen();
    gateway.script(() => undefined);
    const { client } = createClient({ readyTimeoutMs: 150 });

    await expect(client.start()).rejects.toThrow(/did not become ready/u);
    expect(client.isStopped).toBe(true);
  });

  it("fails start() when the socket closes before ready", async () => {
    gateway = await FakeGateway.listen();
    gateway.script((socket) => socket.close(4900, "nope"));
    const { client } = createClient();

    await expect(client.start()).rejects.toThrow(
      /closed before ready \(4900\)/u
    );
    expect(client.isStopped).toBe(true);
  });

  it("fails start() when the gateway URL is missing", async () => {
    gateway = await FakeGateway.listen();
    const { client } = createClient({ url: undefined });

    await expect(client.start()).rejects.toThrow(/did not include a URL/u);
  });

  it("closes the socket when READY arrives before Hello", async () => {
    gateway = await FakeGateway.listen();
    gateway.script((socket) =>
      send(socket, { op: 0, s: 1, t: "READY", d: { session_id: "s" } })
    );
    const { client } = createClient({ readyTimeoutMs: 2_000 });

    await expect(client.start()).rejects.toThrow(
      /closed before ready \(4002\)/u
    );
  });
});

describe("intents", () => {
  it("defaults to group and C2C events, adding interactions on request", () => {
    expect(resolveIntents({})).toBe(1 << 25);
    expect(resolveIntents({ enableInteractions: true })).toBe(
      (1 << 25) | (1 << 26)
    );
  });

  it("honours an explicit override, including zero", () => {
    expect(resolveIntents({ intents: 0, enableInteractions: true })).toBe(0);
    expect(resolveIntents({ intents: 513 })).toBe(513);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid override %s",
    (intents) => {
      expect(() => resolveIntents({ intents })).toThrow(
        /non-negative integer/u
      );
    }
  );

  it("names known bits and reports unknown ones in hex", () => {
    expect(describeIntents(0)).toEqual([]);
    expect(describeIntents((1 << 25) | (1 << 26))).toEqual([
      "GROUP_AND_C2C_EVENT",
      "INTERACTION"
    ]);
    expect(describeIntents((1 << 25) | 0x3)).toEqual([
      "GROUP_AND_C2C_EVENT",
      "OTHER(0x3)"
    ]);
  });
});
