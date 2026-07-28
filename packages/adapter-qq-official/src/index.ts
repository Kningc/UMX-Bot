import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  MemberRole,
  OutgoingMedia,
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
  msg_seq?: number;
  content?: string;
  group_openid?: string;
  timestamp?: string;
  author?: QqAuthor;
  attachments?: QqAttachment[];
  mentions?: QqAuthor[];
}

interface QqAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

interface ReadyData {
  session_id?: string;
}

interface QqMediaUploadResponse {
  file_info?: string;
}

const qqMediaTypes: Record<OutgoingMedia["type"], number> = {
  image: 1,
  video: 2,
  audio: 3,
  file: 4
};

const mediaSizeLimits: Record<OutgoingMedia["type"], number> = {
  image: 20 * 1024 * 1024,
  video: 30 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  file: 100 * 1024 * 1024
};

export interface QqOfficialAdapterOptions {
  appId: string;
  clientSecret: string;
  logger: Logger;
  receiveAllGroupMessages?: boolean;
  apiBaseUrl?: string;
  tokenUrl?: string;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  requestTimeoutMs?: number;
  gatewayReadyTimeoutMs?: number;
}

export class QqOfficialAdapter implements BotAdapter {
  public readonly name = "qq-official";
  private readonly logger: Logger;
  private readonly receiveAllGroupMessages: boolean;
  private readonly apiBaseUrl: string;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly gatewayReadyTimeoutMs: number;
  private readonly tokens: TokenManager;
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatIntervalMs: number | undefined;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private sequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private awaitingHeartbeatAck = false;
  private connectPromise: Promise<void> | undefined;
  private lifecycleController: AbortController | undefined;
  private readonly seenMessages = new Map<string, number>();
  private readonly replySequences = new Map<string, number>();

  public constructor(options: QqOfficialAdapterOptions) {
    this.logger = options.logger;
    this.receiveAllGroupMessages =
      options.receiveAllGroupMessages ?? false;
    this.apiBaseUrl =
      options.apiBaseUrl ?? "https://api.sgroup.qq.com";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.gatewayReadyTimeoutMs = options.gatewayReadyTimeoutMs ?? 15_000;
    for (const [name, value] of [
      ["reconnectDelayMs", this.reconnectDelayMs],
      ["reconnectMaxDelayMs", this.reconnectMaxDelayMs],
      ["requestTimeoutMs", this.requestTimeoutMs],
      ["gatewayReadyTimeoutMs", this.gatewayReadyTimeoutMs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (this.reconnectMaxDelayMs < this.reconnectDelayMs) {
      throw new Error(
        "reconnectMaxDelayMs must be greater than or equal to reconnectDelayMs"
      );
    }
    this.tokens = new TokenManager(
      options.appId,
      options.clientSecret,
      options.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken",
      this.requestTimeoutMs
    );
  }

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    if (!this.stopped) {
      await this.connectPromise;
      return;
    }

    this.stopped = false;
    this.onMessage = onMessage;
    this.lifecycleController = new AbortController();
    try {
      await this.connect();
    } catch (error) {
      this.stopped = true;
      this.lifecycleController.abort();
      this.lifecycleController = undefined;
      this.onMessage = undefined;
      this.clearReconnect();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleController?.abort();
    this.lifecycleController = undefined;
    this.clearReconnect();
    this.clearHeartbeat();

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
    this.onMessage = undefined;
    this.connectPromise = undefined;
    this.awaitingHeartbeatAck = false;
  }

  public async send(message: OutgoingMessage): Promise<void> {
    if (message.scope === "guild") {
      throw new Error("guild messages are not implemented by this adapter yet");
    }

    const messageResource =
      message.scope === "group"
        ? `v2/groups/${encodeURIComponent(message.conversationId)}/messages`
        : `v2/users/${encodeURIComponent(message.conversationId)}/messages`;
    const fileResource =
      message.scope === "group"
        ? `v2/groups/${encodeURIComponent(message.conversationId)}/files`
        : `v2/users/${encodeURIComponent(message.conversationId)}/files`;

    if (typeof message.content === "string") {
      await this.sendMessageBody(
        messageResource,
        this.withReply(
          {
            msg_type: 0,
            content: message.content
          },
          message.replyTo
        )
      );
      return;
    }

    const { text = "", media } = message.content;
    if (media.length === 0) {
      throw new Error("rich message must contain at least one media item");
    }

    if (text.length > 0 && media[0]?.type !== "image") {
      await this.sendMessageBody(
        messageResource,
        this.withReply({ msg_type: 0, content: text }, message.replyTo)
      );
    }

    for (const [index, item] of media.entries()) {
      const fileInfo = await this.uploadMedia(fileResource, item);
      const content =
        index === 0 && item.type === "image" ? text : "";
      await this.sendMessageBody(
        messageResource,
        this.withReply(
          {
            msg_type: 7,
            content,
            media: { file_info: fileInfo }
          },
          message.replyTo
        )
      );
    }
  }

  private withReply(
    body: Record<string, unknown>,
    replyTo: string | undefined
  ): Record<string, unknown> {
    return {
      ...body,
      ...(replyTo
        ? {
            msg_id: replyTo,
            msg_seq: this.nextReplySequence(replyTo)
          }
        : {})
    };
  }

  private async uploadMedia(
    resource: string,
    media: OutgoingMedia
  ): Promise<string> {
    const body: Record<string, unknown> = {
      file_type: qqMediaTypes[media.type],
      srv_send_msg: false
    };
    if (media.filename) {
      body.file_name = media.filename;
    }
    if (media.source.type === "url") {
      let url: URL;
      try {
        url = new URL(media.source.url);
      } catch {
        throw new Error(`invalid ${media.type} URL`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${media.type} URL must use HTTP or HTTPS`);
      }
      body.url = url.toString();
    } else {
      if (media.source.data.byteLength === 0) {
        throw new Error(`${media.type} data cannot be empty`);
      }
      const limit = mediaSizeLimits[media.type];
      if (media.source.data.byteLength > limit) {
        throw new Error(
          `${media.type} exceeds QQ size limit of ${Math.round(limit / 1024 / 1024)} MiB`
        );
      }
      body.file_data = Buffer.from(media.source.data).toString("base64");
    }

    const response = await this.authorizedRequest(resource, body);
    if (!response.ok) {
      throw await this.responseError("QQ media upload failed", response);
    }
    const result = (await response.json()) as QqMediaUploadResponse;
    if (!result.file_info) {
      throw new Error("QQ media upload response did not include file_info");
    }
    return result.file_info;
  }

  private async sendMessageBody(
    resource: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const response = await this.authorizedRequest(resource, body);
    if (!response.ok) {
      throw await this.responseError("QQ message send failed", response);
    }
  }

  private async authorizedRequest(
    resource: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    let token = await this.tokens.get();
    let response = await this.sendRequest(resource, body, token);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      this.tokens.invalidate(token);
      token = await this.tokens.get();
      response = await this.sendRequest(resource, body, token);
    }
    return response;
  }

  private async responseError(
    message: string,
    response: Response
  ): Promise<Error> {
    const responseBody = await response.text();
    return new Error(
      `${message} (${response.status}): ${responseBody.slice(0, 2_000)}`
    );
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
    const token = await this.tokens.get();
    const gatewayResponse = await fetch(`${this.apiBaseUrl}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
      signal: this.requestSignal()
    });
    if (!gatewayResponse.ok) {
      if (gatewayResponse.status === 401 || gatewayResponse.status === 403) {
        this.tokens.invalidate(token);
      }
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
      const readyTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("QQ gateway did not become ready before timeout"));
      }, this.gatewayReadyTimeoutMs);
      readyTimeout.unref();
      this.socket = socket;

      socket.on("message", (data) => {
        void this.handleGatewayMessage(data, token, () => {
          if (!ready) {
            ready = true;
            clearTimeout(readyTimeout);
            this.reconnectAttempts = 0;
            resolve();
          }
        }).catch((error: unknown) => {
          this.logger.error({ error }, "QQ gateway message failed");
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
        if (payload.t === "READY" || payload.t === "RESUMED") {
          const ready = payload.d as ReadyData;
          if (ready.session_id) {
            this.sessionId = ready.session_id;
          }
          this.logger.info(
            { sessionId: this.sessionId, resumed: payload.t === "RESUMED" },
            "QQ gateway ready"
          );
          if (this.heartbeatIntervalMs === undefined) {
            throw new Error(
              "QQ gateway became ready before providing a heartbeat interval"
            );
          }
          this.startHeartbeat(this.heartbeatIntervalMs);
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
        if (
          !Number.isSafeInteger(hello.heartbeat_interval) ||
          (hello.heartbeat_interval ?? 0) <= 0
        ) {
          throw new Error("QQ gateway hello did not include heartbeat interval");
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
    const deduplicationKey = `${source.id}:${source.msg_seq ?? 0}`;
    if (this.seenMessages.has(deduplicationKey)) {
      return;
    }
    this.rememberMessage(deduplicationKey);

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
      attachments: (source.attachments ?? []).flatMap((attachment) =>
        attachment.url
          ? [
              {
                url: attachment.url,
                ...(attachment.filename
                  ? { filename: attachment.filename }
                  : {}),
                ...(attachment.content_type
                  ? { contentType: attachment.content_type }
                  : {}),
                ...(attachment.size !== undefined
                  ? { size: attachment.size }
                  : {}),
                ...(attachment.width !== undefined
                  ? { width: attachment.width }
                  : {}),
                ...(attachment.height !== undefined
                  ? { height: attachment.height }
                  : {})
              }
            ]
          : []
      ),
      mentions: (source.mentions ?? []).flatMap((mention) => {
        const id = mention.member_openid ?? mention.user_openid ?? mention.id;
        return id
          ? [
              {
                id,
                ...(mention.username ? { name: mention.username } : {})
              }
            ]
          : [];
      }),
      timestamp: this.parseTimestamp(source.timestamp),
      raw: data
    };

    await this.onMessage?.(message);
  }

  private normalizeRole(role: string | undefined): MemberRole {
    return role === "owner" || role === "admin" ? role : "member";
  }

  private rememberMessage(id: string): void {
    const now = Date.now();
    this.seenMessages.set(id, now);
    if (this.seenMessages.size > 1_000) {
      for (const [key, seenAt] of this.seenMessages) {
        if (seenAt < now - 10 * 60_000 || this.seenMessages.size > 1_000) {
          this.seenMessages.delete(key);
        }
        if (this.seenMessages.size <= 900) {
          break;
        }
      }
    }
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
      this.sendGateway({ op: 1, d: this.sequence });
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
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts, 10)
    );
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
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

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const lifecycle = this.lifecycleController?.signal;
    return lifecycle ? AbortSignal.any([timeout, lifecycle]) : timeout;
  }

  private async sendRequest(
    resource: string,
    body: Record<string, unknown>,
    token: string
  ): Promise<Response> {
    return fetch(`${this.apiBaseUrl}/${resource}`, {
      method: "POST",
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json"
      },
      signal: this.requestSignal(),
      body: JSON.stringify(body)
    });
  }

  private nextReplySequence(messageId: string): number {
    const next = (this.replySequences.get(messageId) ?? 0) + 1;
    this.replySequences.set(messageId, next);
    if (this.replySequences.size > 1_000) {
      const oldest = this.replySequences.keys().next().value;
      if (oldest) {
        this.replySequences.delete(oldest);
      }
    }
    return next;
  }

  private parseTimestamp(value: string | undefined): Date {
    if (!value) {
      return new Date();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}
