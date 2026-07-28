import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  MemberRole,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
import WebSocket, { type RawData } from "ws";
import { TokenManager } from "./token-manager.js";

const GROUP_AND_C2C_EVENT = 1 << 25;

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface QqAuthor {
  id?: string;
  username?: string;
  member_openid?: string;
  user_openid?: string;
  member_role?: string;
}

interface QqMessage {
  id?: string;
  content?: string;
  group_openid?: string;
  timestamp?: string;
  author?: QqAuthor;
}

interface ReadyData {
  session_id?: string;
}

export interface QqOfficialAdapterOptions {
  appId: string;
  clientSecret: string;
  logger: Logger;
  receiveAllGroupMessages?: boolean;
  apiBaseUrl?: string;
  tokenUrl?: string;
  reconnectDelayMs?: number;
}

export class QqOfficialAdapter implements BotAdapter {
  public readonly name = "qq-official";
  private readonly logger: Logger;
  private readonly receiveAllGroupMessages: boolean;
  private readonly apiBaseUrl: string;
  private readonly reconnectDelayMs: number;
  private readonly tokens: TokenManager;
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private sequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly seenMessageIds = new Set<string>();

  public constructor(options: QqOfficialAdapterOptions) {
    this.logger = options.logger;
    this.receiveAllGroupMessages =
      options.receiveAllGroupMessages ?? false;
    this.apiBaseUrl =
      options.apiBaseUrl ?? "https://api.sgroup.qq.com";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.tokens = new TokenManager(
      options.appId,
      options.clientSecret,
      options.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken"
    );
  }

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.onMessage = onMessage;
    await this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();

    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000, "bot stopping");
      });
    }
  }

  public async send(message: OutgoingMessage): Promise<void> {
    if (message.scope === "guild") {
      throw new Error("guild messages are not implemented by this adapter yet");
    }

    const resource =
      message.scope === "group"
        ? `v2/groups/${encodeURIComponent(message.conversationId)}/messages`
        : `v2/users/${encodeURIComponent(message.conversationId)}/messages`;
    const token = await this.tokens.get();
    const response = await fetch(`${this.apiBaseUrl}/${resource}`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        msg_type: 0,
        content: message.content,
        ...(message.replyTo
          ? { msg_id: message.replyTo, msg_seq: 1 }
          : {})
      })
    });

    if (!response.ok) {
      throw new Error(
        `QQ message send failed (${response.status}): ${await response.text()}`
      );
    }
  }

  private async connect(): Promise<void> {
    const token = await this.tokens.get();
    const gatewayResponse = await fetch(`${this.apiBaseUrl}/gateway`, {
      headers: { authorization: `QQBot ${token}` }
    });
    if (!gatewayResponse.ok) {
      throw new Error(
        `QQ gateway request failed (${gatewayResponse.status}): ${await gatewayResponse.text()}`
      );
    }

    const gateway = (await gatewayResponse.json()) as { url?: string };
    const gatewayUrl = gateway.url;
    if (!gatewayUrl) {
      throw new Error("QQ gateway response did not include a URL");
    }

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const socket = new WebSocket(gatewayUrl);
      this.socket = socket;

      socket.on("message", (data) => {
        void this.handleGatewayMessage(data, token, () => {
          if (!ready) {
            ready = true;
            resolve();
          }
        }).catch((error: unknown) => {
          this.logger.error({ error }, "QQ gateway message failed");
        });
      });
      socket.once("error", (error) => {
        if (!ready) {
          reject(error);
        } else {
          this.logger.error({ error }, "QQ websocket error");
        }
      });
      socket.once("close", (code, reason) => {
        this.clearHeartbeat();
        this.socket = undefined;
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
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        if (payload.t === "READY") {
          const ready = payload.d as ReadyData;
          this.sessionId = ready.session_id;
          this.logger.info({ sessionId: this.sessionId }, "QQ gateway ready");
          markReady();
          return;
        }
        await this.handleDispatch(payload.t, payload.d);
        return;
      case 7:
        this.socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        this.sessionId = undefined;
        this.sequence = null;
        this.socket?.close(4001, "invalid session");
        return;
      case 10: {
        const hello = payload.d as { heartbeat_interval?: number };
        if (!hello.heartbeat_interval) {
          throw new Error("QQ gateway hello did not include heartbeat interval");
        }
        this.startHeartbeat(hello.heartbeat_interval);
        this.identifyOrResume(token);
        return;
      }
      case 11:
        return;
      default:
        this.logger.debug({ op: payload.op }, "ignored QQ gateway opcode");
    }
  }

  private identifyOrResume(token: string): void {
    if (this.sessionId && this.sequence !== null) {
      this.sendGateway({
        op: 6,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.sequence
        }
      });
      return;
    }

    this.sendGateway({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: GROUP_AND_C2C_EVENT,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "qq-bot",
          $device: "qq-bot"
        }
      }
    });
  }

  private async handleDispatch(
    event: string | undefined,
    data: unknown
  ): Promise<void> {
    const supported =
      event === "GROUP_AT_MESSAGE_CREATE" ||
      event === "C2C_MESSAGE_CREATE" ||
      (event === "GROUP_MESSAGE_CREATE" && this.receiveAllGroupMessages);
    if (!supported) {
      return;
    }

    const source = data as QqMessage;
    if (!source.id || !source.author) {
      this.logger.warn({ event }, "ignored malformed QQ message event");
      return;
    }
    if (this.seenMessageIds.has(source.id)) {
      return;
    }
    this.rememberMessage(source.id);

    const isGroup = event !== "C2C_MESSAGE_CREATE";
    const authorId = isGroup
      ? source.author.member_openid ?? source.author.id
      : source.author.user_openid ?? source.author.id;
    const conversationId = isGroup
      ? source.group_openid
      : source.author.user_openid ?? source.author.id;
    if (!authorId || !conversationId) {
      this.logger.warn({ event }, "QQ message is missing OpenID fields");
      return;
    }

    const message: IncomingMessage = {
      id: source.id,
      platform: this.name,
      scope: isGroup ? "group" : "direct",
      conversationId,
      author: {
        id: authorId,
        ...(source.author.username ? { name: source.author.username } : {}),
        role: this.normalizeRole(source.author.member_role)
      },
      content: source.content?.trim() ?? "",
      timestamp: source.timestamp ? new Date(source.timestamp) : new Date(),
      raw: data
    };

    await this.onMessage?.(message);
  }

  private normalizeRole(role: string | undefined): MemberRole {
    return role === "owner" || role === "admin" ? role : "member";
  }

  private rememberMessage(id: string): void {
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > 1_000) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) {
        this.seenMessageIds.delete(oldest);
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const beat = () => this.sendGateway({ op: 1, d: this.sequence });
    beat();
    this.heartbeat = setInterval(beat, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        this.logger.error({ error }, "QQ reconnect failed");
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }
}
