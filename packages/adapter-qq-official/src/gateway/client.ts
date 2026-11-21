import type { Logger } from "@qq-bot/plugin-sdk";
import WebSocket, { type RawData } from "ws";
import { GatewayDispatcher } from "../gateway-dispatcher.js";
import type { QqOpenApiClient } from "../openapi/client.js";
import type { GatewayPayload, QqMessage, ReadyData } from "../protocol.js";
import type { TokenManager } from "../token-manager.js";
import type { QqGatewaySessionStore } from "./session-store.js";

export interface QqGatewayMetrics {
  reconnects: number;
  resumeAttempts: number;
  resumeSuccesses: number;
  restoredSessions: number;
  receivedEvents: number;
  processedEvents: number;
  failedEvents: number;
  unknownEvents: number;
  lastProcessingLatencyMs: number;
}

export interface QqGatewayDiagnostics extends QqGatewayMetrics {
  connected: boolean;
  ready: boolean;
  receivedSequence: number | null;
  processedSequence: number | null;
  eventBacklog: number;
}

export interface QqGatewayClientOptions {
  openApi: QqOpenApiClient;
  tokens: TokenManager;
  sessions: QqGatewaySessionStore;
  logger: Logger;
  intents: number;
  readyTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  /**
   * Handles one business dispatch. Called off the socket read loop, one task
   * per conversation lane, so a slow handler never stalls heartbeats or other
   * conversations.
   */
  onDispatch: (payload: GatewayPayload) => Promise<void>;
}

/**
 * Owns the QQ Gateway WebSocket: Identify/Resume, heartbeats, reconnect
 * backoff and the event watermark.
 *
 * Kept apart from the adapter on purpose. The adapter decides what an event
 * *means*; this type only guarantees the transport contract — above all that
 * progress is committed for a contiguous run of finished events, so a Resume
 * can never skip over an event that is still being handled.
 */
export class QqGatewayClient {
  private readonly options: QqGatewayClientOptions;
  private readonly logger: Logger;
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatIntervalMs: number | undefined;
  private ready = false;
  private receivedSequence: number | null = null;
  private processedSequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private awaitingHeartbeatAck = false;
  private connectPromise: Promise<void> | undefined;
  private messageQueue: Promise<void> = Promise.resolve();
  private dispatcher: GatewayDispatcher;
  private readonly metrics: QqGatewayMetrics = {
    reconnects: 0,
    resumeAttempts: 0,
    resumeSuccesses: 0,
    restoredSessions: 0,
    receivedEvents: 0,
    processedEvents: 0,
    failedEvents: 0,
    unknownEvents: 0,
    lastProcessingLatencyMs: 0
  };

  public constructor(options: QqGatewayClientOptions) {
    this.options = options;
    this.logger = options.logger;
    this.dispatcher = this.createDispatcher();
  }

  public get isStopped(): boolean {
    return this.stopped;
  }

  public get isReady(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  /** Counts an event the adapter could not map, for diagnostics. */
  public noteUnmappedEvent(): void {
    this.metrics.unknownEvents += 1;
  }

  public async start(): Promise<void> {
    if (!this.stopped) {
      await this.connectPromise;
      return;
    }
    this.stopped = false;
    try {
      await this.restoreSession();
      await this.connect();
    } catch (error) {
      this.stopped = true;
      this.clearReconnect();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    this.ready = false;

    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 5_000);
        timeout.unref();
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close(1000, "bot stopping");
      });
    }
    this.connectPromise = undefined;
    this.awaitingHeartbeatAck = false;
  }

  public diagnostics(): QqGatewayDiagnostics {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      ready: this.ready,
      ...this.metrics,
      receivedSequence: this.receivedSequence,
      processedSequence: this.processedSequence,
      eventBacklog: Math.max(
        0,
        this.metrics.receivedEvents -
          this.metrics.processedEvents -
          this.metrics.failedEvents
      )
    };
  }

  private async restoreSession(): Promise<void> {
    const session = await this.options.sessions.restore();
    if (!session) {
      const discarded = this.options.sessions.discardedForIntents;
      if (discarded) {
        this.logger.warn(
          { storedIntents: discarded.stored, intents: discarded.current },
          "stored QQ gateway session was identified with different intents; identifying afresh"
        );
      }
      return;
    }
    this.sessionId = session.sessionId;
    this.processedSequence = session.processedSequence;
    this.receivedSequence = session.processedSequence;
    this.metrics.restoredSessions += 1;
  }

  private async commitSequence(sequence: number | undefined): Promise<void> {
    if (sequence === undefined) {
      return;
    }
    await this.options.sessions.commit(this.sessionId, sequence);
    this.processedSequence = sequence;
  }

  private async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const connecting = this.connectInternal();
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) {
        this.connectPromise = undefined;
      }
    }
  }

  private async connectInternal(): Promise<void> {
    if (this.stopped) {
      throw new Error("cannot connect a stopped QQ adapter");
    }
    const gateway = await this.options.openApi.request<{ url?: string }>({
      method: "GET",
      path: "gateway",
      idempotent: true
    });
    const gatewayUrl = gateway.url;
    if (!gatewayUrl) {
      throw new Error("QQ gateway response did not include a URL");
    }
    const token = await this.options.tokens.get();
    this.messageQueue = Promise.resolve();
    this.replaceDispatcher();
    this.ready = false;

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const socket = new WebSocket(gatewayUrl);
      const readyTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("QQ gateway did not become ready before timeout"));
      }, this.options.readyTimeoutMs);
      readyTimeout.unref();
      this.socket = socket;

      socket.on("message", (data) => {
        void this.enqueueGatewayMessage(data, token, () => {
          if (!ready) {
            ready = true;
            clearTimeout(readyTimeout);
            this.reconnectAttempts = 0;
            resolve();
          }
        }).catch((error: unknown) => {
          this.logger.error({ error }, "QQ gateway message failed");
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(4002, "gateway event processing failed");
          }
        });
      });
      socket.once("error", (error) => {
        if (!ready) {
          clearTimeout(readyTimeout);
          reject(error);
          socket.terminate();
        } else {
          this.logger.error({ error }, "QQ websocket error");
        }
      });
      socket.once("close", (code, reason) => {
        clearTimeout(readyTimeout);
        this.clearHeartbeat();
        this.heartbeatIntervalMs = undefined;
        if (this.socket === socket) {
          this.socket = undefined;
        }
        this.ready = false;
        this.logger.warn(
          { code, reason: reason.toString() },
          "QQ websocket closed"
        );
        if (!ready) {
          reject(new Error(`QQ websocket closed before ready (${code})`));
        }
        this.scheduleReconnect();
      });
    });
  }

  private async handleGatewayMessage(
    data: RawData,
    token: string,
    markReady: () => void
  ): Promise<void> {
    const payload = JSON.parse(data.toString()) as GatewayPayload;
    if (typeof payload.s === "number") {
      this.receivedSequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        if (payload.t === "READY" || payload.t === "RESUMED") {
          const readyData = payload.d as ReadyData;
          if (readyData.session_id) {
            this.sessionId = readyData.session_id;
          }
          this.logger.info(
            { sessionId: this.sessionId, resumed: payload.t === "RESUMED" },
            "QQ gateway ready"
          );
          if (payload.t === "RESUMED") {
            this.metrics.resumeSuccesses += 1;
          }
          if (this.heartbeatIntervalMs === undefined) {
            throw new Error(
              "QQ gateway became ready before providing a heartbeat interval"
            );
          }
          this.startHeartbeat(this.heartbeatIntervalMs);
          await this.commitSequence(payload.s);
          this.ready = true;
          markReady();
          return;
        }
        // Dispatches run off the Gateway read loop so heartbeats and other
        // conversations keep flowing while a slow plugin handles one event.
        this.metrics.receivedEvents += 1;
        this.dispatcher.schedule(payload.s, dispatchLane(payload), async () => {
          if (this.stopped) {
            return false;
          }
          await this.options.onDispatch(payload);
          return true;
        });
        return;
      case 7:
        this.socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        this.replaceDispatcher();
        this.sessionId = undefined;
        this.receivedSequence = null;
        this.processedSequence = null;
        this.ready = false;
        await this.options.sessions.clear();
        this.socket?.close(4001, "invalid session");
        return;
      case 10: {
        const hello = payload.d as { heartbeat_interval?: number };
        if (
          !Number.isSafeInteger(hello.heartbeat_interval) ||
          (hello.heartbeat_interval ?? 0) <= 0
        ) {
          throw new Error(
            "QQ gateway hello did not include heartbeat interval"
          );
        }
        this.heartbeatIntervalMs = hello.heartbeat_interval;
        this.identifyOrResume(token);
        return;
      }
      case 1:
        this.sendHeartbeat();
        return;
      case 11:
        this.awaitingHeartbeatAck = false;
        return;
      default:
        this.logger.debug({ op: payload.op }, "ignored QQ gateway opcode");
    }
  }

  private createDispatcher(): GatewayDispatcher {
    return new GatewayDispatcher({
      commit: (sequence) => this.commitSequence(sequence),
      logger: this.logger,
      onFinished: (outcome, latencyMs) => {
        if (outcome === "processed") {
          this.metrics.processedEvents += 1;
        } else {
          this.metrics.failedEvents += 1;
        }
        this.metrics.lastProcessingLatencyMs = latencyMs;
      }
    });
  }

  /** Detaches in-flight events of a dead connection from progress commits. */
  private replaceDispatcher(): void {
    this.dispatcher.close();
    this.dispatcher = this.createDispatcher();
  }

  private enqueueGatewayMessage(
    data: RawData,
    token: string,
    markReady: () => void
  ): Promise<void> {
    const queued = this.messageQueue.then(() =>
      this.handleGatewayMessage(data, token, markReady)
    );
    this.messageQueue = queued;
    return queued;
  }

  private identifyOrResume(token: string): void {
    if (this.sessionId && this.processedSequence !== null) {
      this.metrics.resumeAttempts += 1;
      this.sendGateway({
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.processedSequence
        }
      });
      return;
    }

    this.sendGateway({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: this.options.intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "qq-bot",
          $device: "qq-bot"
        }
      }
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const beat = (): void => {
      if (this.awaitingHeartbeatAck) {
        this.logger.warn({}, "QQ heartbeat ACK timed out; reconnecting");
        this.socket?.terminate();
        return;
      }
      this.sendHeartbeat();
    };
    this.heartbeat = setInterval(beat, intervalMs);
  }

  private sendHeartbeat(): void {
    try {
      this.sendGateway({ op: 1, d: this.processedSequence });
      this.awaitingHeartbeatAck = true;
    } catch (error) {
      this.logger.warn({ error }, "QQ heartbeat send failed");
      this.socket?.terminate();
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.awaitingHeartbeatAck = false;
  }

  private sendGateway(payload: GatewayPayload): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("QQ websocket is not open");
    }
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const exponential = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts, 10)
    );
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
    this.metrics.reconnects += 1;
    this.logger.warn(
      { attempt: this.reconnectAttempts, delayMs: delay },
      "QQ reconnect scheduled"
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        this.logger.error({ error }, "QQ reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

/**
 * Dispatch lane key. Events in the same conversation keep strict arrival
 * order; different conversations run concurrently.
 */
export function dispatchLane(payload: GatewayPayload): string {
  const data = (payload.d ?? {}) as QqMessage;
  switch (payload.t) {
    case "GROUP_AT_MESSAGE_CREATE":
    case "GROUP_MESSAGE_CREATE":
      return `group:${data.group_openid ?? ""}`;
    case "C2C_MESSAGE_CREATE":
      return `direct:${data.author?.user_openid ?? data.author?.id ?? ""}`;
    default:
      return "lifecycle";
  }
}
