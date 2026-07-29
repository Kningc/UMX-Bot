import { createHash } from "node:crypto";
import type {
  Awaitable,
  BotAdapter,
  BotEvents,
  ConversationRef,
  IncomingMessage,
  KeyValueStore,
  Logger,
  MessageKeyboard,
  MessageStream,
  MessageStreamOptions,
  MessageStreamState,
  MemberRole,
  OutgoingMedia,
  OutgoingMessage,
  PlatformEvent,
  ReplyTarget,
  SentMessage
} from "@qq-bot/plugin-sdk";
import {
  QQ_HEAD_CHECKSUM_BYTES,
  QQ_PLATFORM
} from "@qq-bot/plugin-sdk-qq";
import WebSocket, { type RawData } from "ws";
import { QqOpenApiClient } from "./openapi/client.js";
import { QqApiError } from "./openapi/error.js";
import {
  QqQuotaGovernor,
  type QqCertification
} from "./quota-governor.js";
import { TokenManager } from "./token-manager.js";

const GROUP_AND_C2C_EVENT = 1 << 25;
const INTERACTION_EVENT = 1 << 26;
const qqButtonStyles = {
  default: 0,
  primary: 1,
  success: 2,
  danger: 3
} as const;

interface GatewayPayload {
  id?: string;
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
  file_uuid?: string;
  ttl?: number;
}

interface QqUploadPrepareResponse {
  upload_id?: string;
  block_size?: string;
  parts?: Array<{
    index?: number;
    presigned_url?: string;
    block_size?: string;
  }>;
  upload_config?: {
    concurrency?: number;
    retry_timeout?: number;
    retry_delay?: number;
  };
}

interface QqMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: unknown;
  remain_msg_len?: number;
}

interface PersistedGatewayState {
  sessionId: string;
  processedSequence: number;
}

interface PersistedOutboxRecord {
  status: "pending" | "sending" | "sent" | "uncertain";
  updatedAt: string;
  receipt?: Omit<SentMessage, "timestamp"> & { timestamp: string };
  sentCount?: number;
  error?: string;
  stream?: PersistedStreamState;
}

interface PersistedStreamChunk {
  inputMode: "append" | "replace";
  inputState: 1 | 10;
  index: number;
  content: string;
}

interface PersistedStreamState {
  id: string;
  conversationId: string;
  contentType: "text" | "markdown";
  currentContent: string;
  nextIndex: number;
  state: "open" | "completed" | "uncertain" | "aborted";
  pendingChunk?: PersistedStreamChunk;
  lastReceipt: Omit<SentMessage, "timestamp"> & { timestamp: string };
}

const qqMediaTypes: Record<OutgoingMedia["type"], number> = {
  image: 1,
  video: 2,
  audio: 3,
  file: 4
};

const mediaSizeLimits: Record<OutgoingMedia["type"], number> = {
  image: 200 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  file: 200 * 1024 * 1024
};
const multipartThreshold = 5 * 1024 * 1024;

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
  enableInteractions?: boolean;
  intents?: number;
  gatewayStateStore?: KeyValueStore;
  certification?: QqCertification;
}

export interface QqOfficialDiagnostics extends Record<string, unknown> {
  openApi: ReturnType<QqOpenApiClient["getMetrics"]>;
  gateway: {
    connected: boolean;
    ready: boolean;
    reconnects: number;
    resumeAttempts: number;
    resumeSuccesses: number;
    restoredSessions: number;
    receivedEvents: number;
    processedEvents: number;
    failedEvents: number;
    unknownEvents: number;
    lastProcessingLatencyMs: number;
    receivedSequence: number | null;
    processedSequence: number | null;
    eventBacklog: number;
  };
}

export type QqDeliveryStatus = "enabled" | "disabled" | "unknown";
export type QqOutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "uncertain"
  | "missing";

export class QqOfficialAdapter implements BotAdapter {
  public readonly name = "qq-official";
  private readonly appId: string;
  private readonly logger: Logger;
  private readonly receiveAllGroupMessages: boolean;
  private readonly apiBaseUrl: string;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly gatewayReadyTimeoutMs: number;
  private readonly intents: number;
  private readonly gatewayStateStore: KeyValueStore | undefined;
  private readonly tokens: TokenManager;
  private readonly openApi: QqOpenApiClient;
  private readonly quota: QqQuotaGovernor;
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatIntervalMs: number | undefined;
  private gatewayReady = false;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private onEvent:
    | (<K extends Exclude<keyof BotEvents, "message.created">>(
        event: K,
        payload: BotEvents[K]
      ) => Awaitable<void>)
    | undefined;
  private receivedSequence: number | null = null;
  private processedSequence: number | null = null;
  private sessionId: string | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private awaitingHeartbeatAck = false;
  private connectPromise: Promise<void> | undefined;
  private gatewayMessageQueue: Promise<void> = Promise.resolve();
  private lifecycleController: AbortController | undefined;
  private readonly seenMessages = new Map<string, number>();
  private readonly processingMessages = new Map<string, Promise<void>>();
  private readonly unknownEventWarnings = new Map<string, number>();
  private readonly replySequences = new Map<string, number>();
  private readonly outbox = new Map<string, PersistedOutboxRecord>();
  private readonly mediaCache = new Map<
    string,
    {
      fileInfo: string;
      expiresAt: number;
      raw: QqMediaUploadResponse;
    }
  >();
  private readonly gatewayMetrics = {
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

  public constructor(options: QqOfficialAdapterOptions) {
    this.appId = options.appId;
    this.logger = options.logger;
    this.receiveAllGroupMessages =
      options.receiveAllGroupMessages ?? false;
    this.apiBaseUrl =
      options.apiBaseUrl ?? "https://api.bot.qq.com";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.gatewayReadyTimeoutMs = options.gatewayReadyTimeoutMs ?? 15_000;
    this.intents =
      options.intents ??
      (GROUP_AND_C2C_EVENT |
        (options.enableInteractions ? INTERACTION_EVENT : 0));
    this.gatewayStateStore = options.gatewayStateStore;
    this.quota = new QqQuotaGovernor(
      options.appId,
      options.certification ?? "unverified",
      options.gatewayStateStore
    );
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
    this.openApi = new QqOpenApiClient({
      baseUrl: this.apiBaseUrl,
      tokenManager: this.tokens,
      logger: this.logger,
      timeoutMs: this.requestTimeoutMs,
      lifecycleSignal: () => this.lifecycleController?.signal
    });
  }

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>,
    onEvent?: <K extends Exclude<keyof BotEvents, "message.created">>(
      event: K,
      payload: BotEvents[K]
    ) => Awaitable<void>
  ): Promise<void> {
    if (!this.stopped) {
      await this.connectPromise;
      return;
    }

    this.stopped = false;
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.lifecycleController = new AbortController();
    try {
      await this.restoreGatewayState();
      await this.connect();
    } catch (error) {
      this.stopped = true;
      this.lifecycleController.abort();
      this.lifecycleController = undefined;
      this.onMessage = undefined;
      this.onEvent = undefined;
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
    this.gatewayReady = false;

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
    this.onEvent = undefined;
    this.connectPromise = undefined;
    this.awaitingHeartbeatAck = false;
  }

  public getDiagnostics(): QqOfficialDiagnostics {
    return {
      openApi: this.openApi.getMetrics(),
      gateway: {
        connected: this.socket?.readyState === WebSocket.OPEN,
        ready: this.gatewayReady,
        ...this.gatewayMetrics,
        receivedSequence: this.receivedSequence,
        processedSequence: this.processedSequence,
        eventBacklog: Math.max(
          0,
          this.gatewayMetrics.receivedEvents -
            this.gatewayMetrics.processedEvents -
            this.gatewayMetrics.failedEvents
        )
      }
    };
  }

  public async getDeliveryStatus(
    conversation: ConversationRef
  ): Promise<QqDeliveryStatus> {
    if (
      conversation.platform !== this.name ||
      conversation.scope === "guild"
    ) {
      return "unknown";
    }
    const enabled = await this.gatewayStateStore?.get<boolean>(
      this.deliveryPreferenceKey(
        conversation.scope,
        conversation.conversationId
      )
    );
    return enabled === undefined
      ? "unknown"
      : enabled
        ? "enabled"
        : "disabled";
  }

  public async getOutboxStatus(
    idempotencyKey: string
  ): Promise<QqOutboxStatus> {
    const record = await this.getOutbox(
      this.outboxKey(idempotencyKey.trim())
    );
    return record?.status ?? "missing";
  }

  public async send(message: OutgoingMessage): Promise<SentMessage> {
    await this.assertDeliveryAllowed(message);
    if (message.delivery.type === "passive") {
      return this.sendInternal(message);
    }

    const idempotencyKey = message.delivery.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error(
        "QQ active and wakeup messages require a 1-128 character idempotency key"
      );
    }
    const outboxKey = this.outboxKey(idempotencyKey);
    const reservation = await this.reserveOutbox(outboxKey);
    const current = reservation.record;
    if (!reservation.created && current.status === "sent" && current.receipt) {
      return {
        ...current.receipt,
        timestamp: new Date(current.receipt.timestamp)
      };
    }
    if (!reservation.created) {
      throw new QqApiError(
        "QQ message outcome is uncertain; refusing an automatic resend",
        {
          httpStatus: 0,
          endpoint: "OUTBOX",
          retryable: false,
          kind: "unknown"
        }
      );
    }

    await this.setOutbox(outboxKey, {
      status: "sending",
      updatedAt: new Date().toISOString(),
      sentCount: 0
    });
    let sentCount = 0;
    let receipt: SentMessage;
    try {
      receipt = await this.sendInternal(message, () => {
        sentCount += 1;
      });
    } catch (error) {
      if (
        sentCount > 0 ||
        (error instanceof QqApiError && error.httpStatus === 0)
      ) {
        await this.keepUncertainOutbox(outboxKey, sentCount, error);
      } else {
        await this.deleteOutbox(outboxKey);
      }
      throw error;
    }
    try {
      await this.setOutbox(outboxKey, {
        status: "sent",
        updatedAt: new Date().toISOString(),
        receipt: {
          ...receipt,
          timestamp: receipt.timestamp.toISOString()
        }
      });
      return receipt;
    } catch (error) {
      await this.keepUncertainOutbox(outboxKey, Math.max(1, sentCount), error);
      throw error;
    }
  }

  private async sendInternal(
    message: OutgoingMessage,
    onMessageSent?: () => void
  ): Promise<SentMessage> {
    if (message.scope === "guild") {
      throw new Error("guild messages are not implemented by this adapter yet");
    }
    if (qqDeliveryType(message.delivery) === "wakeup" && message.scope !== "direct") {
      throw new Error("QQ wakeup messages are only supported in direct chats");
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
      const receipt = await this.sendMessageBody(
        message,
        messageResource,
        this.withDelivery(
          {
            msg_type: 0,
            content: message.content,
            ...this.messageReference(message)
          },
          message.delivery
        )
      );
      onMessageSent?.();
      return receipt;
    }

    const {
      text = "",
      markdown,
      media = [],
      keyboard
    } = message.content;
    if (!markdown && media.length === 0 && !keyboard) {
      throw new Error(
        "rich message must contain markdown, media or a keyboard"
      );
    }
    if ((markdown || keyboard) && media.length > 0) {
      throw new Error(
        "QQ markdown/keyboard messages cannot be combined with media"
      );
    }
    if (markdown || keyboard) {
      const receipt = await this.sendMarkdownMessage(
        message,
        messageResource,
        {
          markdown: markdown ?? text,
          ...(keyboard ? { keyboard } : {})
        }
      );
      onMessageSent?.();
      return receipt;
    }

    const receipts: SentMessage[] = [];
    if (text.length > 0 && media[0]?.type !== "image") {
      receipts.push(await this.sendMessageBody(
        message,
        messageResource,
        this.withDelivery(
          {
            msg_type: 0,
            content: text,
            ...this.messageReference(message)
          },
          message.delivery
        )
      ));
      onMessageSent?.();
    }

    for (const [index, item] of media.entries()) {
      const upload = await this.uploadMedia(
        fileResource,
        item,
        message.conversationId,
        message.scope
      );
      const content =
        index === 0 && item.type === "image" ? text : "";
      receipts.push(await this.sendMessageBody(
        message,
        messageResource,
        this.withDelivery(
          {
            msg_type: 7,
            content,
            media: { file_info: upload.fileInfo },
            ...this.messageReference(message)
          },
          message.delivery
        )
      ));
      onMessageSent?.();
    }
    const receipt = receipts.at(-1);
    if (!receipt) {
      throw new Error("QQ message did not produce a send receipt");
    }
    return receipts.length === 1
      ? receipt
      : { ...receipt, raw: { messages: receipts.map((item) => item.raw) } };
  }

  private async sendMarkdownMessage(
    message: OutgoingMessage,
    resource: string,
    content: { markdown: string; keyboard?: MessageKeyboard }
  ): Promise<SentMessage> {
    if (content.markdown.trim().length === 0) {
      throw new Error("QQ markdown content cannot be empty");
    }
    const base = {
      msg_type: 2,
      markdown: { content: content.markdown },
      ...this.messageReference(message)
    };
    const body = this.withDelivery(
      {
        ...base,
        ...(content.keyboard
          ? { keyboard: this.serializeKeyboard(content.keyboard) }
          : {})
      },
      message.delivery
    );
    try {
      return await this.sendMessageBody(message, resource, body);
    } catch (error) {
      if (
        !content.keyboard ||
        !(error instanceof QqApiError) ||
        (error.httpStatus !== 400 && error.httpStatus !== 403)
      ) {
        throw error;
      }
      this.logger.warn(
        {
          endpoint: error.endpoint,
          httpStatus: error.httpStatus,
          errCode: error.errCode,
          traceId: error.traceId
        },
        "QQ keyboard unavailable; falling back to markdown"
      );
      return this.sendMessageBody(
        message,
        resource,
        this.withDelivery(base, message.delivery)
      );
    }
  }

  private serializeKeyboard(keyboard: MessageKeyboard): Record<string, unknown> {
    if ("platform" in keyboard) {
      if (
        keyboard.platform !== QQ_PLATFORM ||
        keyboard.kind !== "keyboard-template"
      ) {
        throw new Error(
          `QQ adapter does not support ${keyboard.platform} keyboard kind "${keyboard.kind}"`
        );
      }
      const templateId = keyboard.id.trim();
      if (!templateId) {
        throw new Error("QQ keyboard templateId cannot be empty");
      }
      return { id: templateId };
    }
    if (keyboard.rows.length === 0 || keyboard.rows.length > 5) {
      throw new Error("QQ keyboard must contain between 1 and 5 rows");
    }
    return {
      content: {
        rows: keyboard.rows.map((row, rowIndex) => {
          if (row.length === 0 || row.length > 5) {
            throw new Error(
              "QQ keyboard rows must contain between 1 and 5 buttons"
            );
          }
          return {
            buttons: row.map((button, buttonIndex) => {
              const label = button.label.trim();
              if (label.length === 0 || label.length > 10) {
                throw new Error("QQ keyboard button labels must be 1-10 characters");
              }
              const actionData =
                button.action === "link" ? button.url.trim() : button.data.trim();
              if (!actionData) {
                throw new Error("QQ keyboard button action data cannot be empty");
              }
              if (actionData.length > 1024) {
                throw new Error("QQ keyboard button action data is too long");
              }
              if (button.action === "link") {
                const url = new URL(actionData);
                if (url.protocol !== "http:" && url.protocol !== "https:") {
                  throw new Error("QQ keyboard links must use HTTP or HTTPS");
                }
              }
              const permission = button.visibleTo?.userIds?.length
                ? {
                    type: 0,
                    specify_user_ids: [...button.visibleTo.userIds]
                  }
                : {
                    type:
                      button.visibleTo?.minimumRole === "admin" ||
                      button.visibleTo?.minimumRole === "owner"
                        ? 1
                        : 2
                  };
              return {
                id: button.id ?? `${rowIndex + 1}-${buttonIndex + 1}`,
                render_data: {
                  label,
                  visited_label: label,
                  style: qqButtonStyles[button.style ?? "default"]
                },
                action: {
                  type:
                    button.action === "link"
                      ? 0
                      : button.action === "callback"
                        ? 1
                        : 2,
                  permission,
                  data: actionData,
                  ...(button.action === "command"
                    ? {
                        enter: button.enter ?? true,
                        reply: button.reply ?? false,
                        unsupport_tips: `请手动发送 ${actionData}`
                      }
                    : {})
                }
              };
            })
          };
        })
      }
    };
  }

  private withDelivery(
    body: Record<string, unknown>,
    delivery: OutgoingMessage["delivery"]
  ): Record<string, unknown> {
    const deliveryType = qqDeliveryType(delivery);
    if (deliveryType === "active") {
      return body;
    }
    if (deliveryType === "wakeup") {
      return { ...body, is_wakeup: true };
    }
    if (delivery.type !== "passive") {
      throw new Error("QQ delivery normalization failed");
    }
    if (delivery.target.type === "event") {
      return { ...body, event_id: delivery.target.eventId };
    }
    return {
      ...body,
      msg_id: delivery.target.messageId,
      msg_seq: this.nextReplySequence(delivery.target.messageId)
    };
  }

  private messageReference(
    message: OutgoingMessage
  ): Record<string, unknown> {
    if (!message.reference) {
      return {};
    }
    return {
      message_reference: {
        message_id: message.reference.messageId,
        ignore_get_message_error:
          message.reference.ignoreGetMessageError ?? false
      }
    };
  }

  private async uploadMedia(
    resource: string,
    media: OutgoingMedia,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): Promise<{ fileInfo: string; ttl?: number; raw: QqMediaUploadResponse }> {
    const cacheKey = this.mediaCacheKey(
      media,
      conversationId,
      scope
    );
    const cached = this.mediaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        fileInfo: cached.fileInfo,
        ttl:
          cached.expiresAt === Number.POSITIVE_INFINITY
            ? 0
            : Math.max(0, Math.floor((cached.expiresAt - Date.now()) / 1_000)),
        raw: cached.raw
      };
    }
    this.mediaCache.delete(cacheKey);
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
    } else if (media.source.type === "data") {
      if (media.source.data.byteLength === 0) {
        throw new Error(`${media.type} data cannot be empty`);
      }
      const limit = mediaSizeLimits[media.type];
      if (media.source.data.byteLength > limit) {
        throw new Error(
          `${media.type} exceeds QQ size limit of ${Math.round(limit / 1024 / 1024)} MiB`
        );
      }
      if (media.source.data.byteLength > multipartThreshold) {
        const multipart = await this.uploadMultipart(
          resource,
          media,
          media.source.data,
          conversationId,
          scope
        );
        this.cacheMedia(cacheKey, multipart);
        return multipart;
      }
      body.file_data = Buffer.from(media.source.data).toString("base64");
    } else {
      validateStreamSource(media);
      const multipart = await this.uploadMultipart(
        resource,
        media,
        media.source,
        conversationId,
        scope
      );
      this.cacheMedia(cacheKey, multipart);
      return multipart;
    }

    const result = await this.openApi.request<QqMediaUploadResponse>({
      method: "POST",
      path: resource,
      body,
      rateLimitKey: [
        "media",
        scope,
        conversationId
      ].join(":")
    });
    if (!result.file_info) {
      throw new Error("QQ media upload response did not include file_info");
    }
    const upload = {
      fileInfo: result.file_info,
      ...(result.ttl !== undefined ? { ttl: result.ttl } : {}),
      raw: result
    };
    this.cacheMedia(cacheKey, upload);
    return upload;
  }

  private mediaCacheKey(
    media: OutgoingMedia,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): string {
    const source =
      media.source.type === "url"
        ? media.source.url
        : media.source.type === "data"
          ? digest("sha1", media.source.data)
          : requireChecksum(media, "sha1");
    return [scope, conversationId, media.type, source].join("\u001f");
  }

  private cacheMedia(
    key: string,
    upload: {
      fileInfo: string;
      ttl?: number;
      raw: QqMediaUploadResponse;
    }
  ): void {
    if (upload.ttl === undefined) {
      return;
    }
    this.mediaCache.set(key, {
      fileInfo: upload.fileInfo,
      expiresAt:
        upload.ttl === 0
          ? Number.POSITIVE_INFINITY
          : Date.now() + Math.max(0, upload.ttl - 5) * 1_000,
      raw: upload.raw
    });
  }

  private async uploadMultipart(
    fileResource: string,
    media: OutgoingMedia,
    source:
      | Uint8Array
      | Extract<OutgoingMedia["source"], { type: "stream" }>,
    conversationId: string,
    scope: OutgoingMessage["scope"]
  ): Promise<{ fileInfo: string; ttl?: number; raw: QqMediaUploadResponse }> {
    const prepareResource = fileResource.replace(/\/files$/u, "/upload_prepare");
    const finishResource = fileResource.replace(
      /\/files$/u,
      "/upload_part_finish"
    );
    const filename =
      media.filename ??
      `upload.${media.type === "image" ? "png" : media.type === "video" ? "mp4" : media.type === "audio" ? "silk" : "bin"}`;
    const size = source instanceof Uint8Array ? source.byteLength : source.size;
    const md5 =
      source instanceof Uint8Array ? digest("md5", source) : requireChecksum(media, "md5");
    const sha1 =
      source instanceof Uint8Array ? digest("sha1", source) : requireChecksum(media, "sha1");
    const md5_10m =
      source instanceof Uint8Array
        ? digest("md5", source.subarray(0, QQ_HEAD_CHECKSUM_BYTES))
        : requireChecksum(media, "md5", QQ_HEAD_CHECKSUM_BYTES);
    const prepare = await this.openApi.request<QqUploadPrepareResponse>({
      method: "POST",
      path: prepareResource,
      body: {
        file_type: qqMediaTypes[media.type],
        file_size: String(size),
        file_name: filename,
        md5,
        sha1,
        md5_10m
      },
      rateLimitKey: `media-prepare:${scope}:${conversationId}`
    });
    if (!prepare.upload_id || !prepare.parts?.length) {
      throw new Error(
        "QQ multipart prepare response did not include upload_id and parts"
      );
    }
    const parts = [...prepare.parts].sort(
      (left, right) => (left.index ?? -1) - (right.index ?? -1)
    );
    const streamReader =
      source instanceof Uint8Array
        ? undefined
        : new AsyncPartReader(source.stream, source.size);
    let offset = 0;
    for (const [expectedIndex, part] of parts.entries()) {
      if (
        part.index !== expectedIndex ||
        !part.presigned_url ||
        !part.block_size
      ) {
        throw new Error("QQ multipart prepare returned an invalid part list");
      }
      const requestedSize = Number(part.block_size);
      if (!Number.isSafeInteger(requestedSize) || requestedSize <= 0) {
        throw new Error("QQ multipart prepare returned an invalid block size");
      }
      const chunk =
        source instanceof Uint8Array
          ? source.subarray(
              offset,
              Math.min(offset + requestedSize, source.byteLength)
            )
          : await streamReader!.read(requestedSize);
      if (chunk.byteLength === 0) {
        throw new Error("QQ multipart prepare returned too many parts");
      }
      await this.openApi.uploadBinary(part.presigned_url, chunk);
      await this.openApi.request<void>({
        method: "POST",
        path: finishResource,
        body: {
          upload_id: prepare.upload_id,
          part_index: part.index,
          block_size: String(chunk.byteLength),
          md5: digest("md5", chunk)
        },
        rateLimitKey: `media-finish:${scope}:${conversationId}`
      });
      offset += chunk.byteLength;
    }
    if (offset !== size) {
      throw new Error("QQ multipart prepare did not cover the whole file");
    }
    await streamReader?.assertComplete();
    const result = await this.openApi.request<QqMediaUploadResponse>({
      method: "POST",
      path: fileResource,
      body: {
        file_type: qqMediaTypes[media.type],
        srv_send_msg: false,
        file_name: filename,
        upload_id: prepare.upload_id
      },
      rateLimitKey: `media-merge:${scope}:${conversationId}`
    });
    if (!result.file_info) {
      throw new Error("QQ multipart merge response did not include file_info");
    }
    return {
      fileInfo: result.file_info,
      ...(result.ttl !== undefined ? { ttl: result.ttl } : {}),
      raw: result
    };
  }

  private async sendMessageBody(
    message: OutgoingMessage,
    resource: string,
    body: Record<string, unknown>
  ): Promise<SentMessage> {
    const deliveryType = qqDeliveryType(message.delivery);
    if (deliveryType !== "passive") {
      await this.quota.consumeMessage({
        scope: message.scope,
        conversationId: message.conversationId,
        deliveryType
      });
    }
    const result = await this.openApi.request<QqMessageResponse>({
      method: "POST",
      path: resource,
      body,
      rateLimitKey: [
        "message",
        message.scope,
        message.conversationId,
        deliveryType
      ].join(":")
    });
    if (!result?.id) {
      throw new Error("QQ message response did not include an id");
    }
    return {
      platform: this.name,
      scope: message.scope,
      conversationId: message.conversationId,
      id: result.id,
      timestamp: this.parseTimestamp(result.timestamp),
      raw: result
    };
  }

  public async recall(message: SentMessage): Promise<void> {
    if (message.platform !== this.name) {
      throw new Error("cannot recall a message from another platform");
    }
    if (message.scope === "guild") {
      throw new Error("guild message recall is not supported");
    }
    const path =
      message.scope === "group"
        ? `v2/groups/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}`
        : `v2/users/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}`;
    await this.openApi.request<void>({
      method: "DELETE",
      path,
      idempotent: true,
      rateLimitKey: `recall:${message.scope}:${message.conversationId}`
    });
  }

  public async setTyping(
    conversation: ConversationRef,
    seconds: number,
    target: ReplyTarget
  ): Promise<void> {
    if (conversation.platform !== this.name || conversation.scope !== "direct") {
      throw new Error("QQ typing status is only supported for direct chats");
    }
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
      throw new Error("QQ typing duration must be an integer from 1 to 60 seconds");
    }
    await this.openApi.request<QqMessageResponse>({
      method: "POST",
      path: `v2/users/${encodeURIComponent(conversation.conversationId)}/messages`,
      body: this.withDelivery(
        {
          msg_type: 6,
          input_notify: {
            input_type: 1,
            input_second: seconds
          }
        },
        { type: "passive", target }
      ),
      rateLimitKey: `typing:${conversation.conversationId}`
    });
  }

  public async checkHealth(): Promise<void> {
    if (!this.gatewayReady || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("QQ Gateway is not ready");
    }
    const gateway = await this.openApi.request<{ url?: string }>({
      method: "GET",
      path: "gateway",
      idempotent: true,
      rateLimitKey: "health:gateway"
    });
    if (!gateway.url) {
      throw new Error("QQ health probe did not return a Gateway URL");
    }
  }

  public async openMessageStream(
    options: MessageStreamOptions
  ): Promise<MessageStream> {
    if (
      options.conversation.platform !== this.name ||
      options.conversation.scope !== "direct"
    ) {
      throw new Error("QQ streams are only supported for QQ direct chats");
    }
    if (!options.initialContent) {
      throw new Error("QQ stream initial content cannot be empty");
    }
    await this.assertDeliveryAllowed({
      scope: "direct",
      conversationId: options.conversation.conversationId,
      content: options.initialContent,
      delivery: options.delivery
    });
    const path = `v2/users/${encodeURIComponent(options.conversation.conversationId)}/stream_messages`;
    const deliveryFields = this.withDelivery({}, options.delivery);
    const outboxKey =
      options.delivery.type === "passive"
        ? undefined
        : this.outboxKey(options.delivery.idempotencyKey.trim());
    if (outboxKey) {
      const reservation = await this.reserveOutbox(outboxKey);
      const current = reservation.record;
      if (!reservation.created && current.stream) {
        return this.createMessageStream(
          current.stream,
          options.delivery,
          deliveryFields,
          outboxKey
        );
      }
      if (!reservation.created) {
        throw new QqApiError(
          "QQ idempotency key is already used by another message",
          {
            httpStatus: 0,
            endpoint: "STREAM_OUTBOX",
            retryable: false,
            kind: "unknown"
          }
        );
      }
      await this.setOutbox(outboxKey, {
        ...current,
        status: "sending",
        updatedAt: new Date().toISOString(),
        sentCount: 0
      });
    }
    let first: SentMessage;
    try {
      first = await this.sendStreamChunk(
        path,
        options.conversation.conversationId,
        options.delivery,
        {
          input_mode: options.inputMode ?? "replace",
          input_state: 1,
          index: 0,
          content_type: options.contentType,
          content_raw: options.initialContent,
          ...deliveryFields
        }
      );
    } catch (error) {
      if (outboxKey) {
        if (error instanceof QqApiError && error.httpStatus > 0) {
          await this.deleteOutbox(outboxKey);
        } else {
          await this.keepUncertainOutbox(outboxKey, 0, error);
        }
      }
      throw error;
    }
    const stream: PersistedStreamState = {
      id: first.id,
      conversationId: options.conversation.conversationId,
      contentType: options.contentType,
      currentContent: options.initialContent,
      nextIndex: 1,
      state: "open",
      lastReceipt: serializeReceipt(first)
    };
    if (outboxKey) {
      try {
        await this.setOutbox(outboxKey, {
          status: "sending",
          updatedAt: new Date().toISOString(),
          sentCount: 1,
          stream
        });
      } catch (error) {
        stream.state = "uncertain";
        await this.keepUncertainStream(outboxKey, stream, error);
        throw error;
      }
    }
    return this.createMessageStream(
      stream,
      options.delivery,
      deliveryFields,
      outboxKey
    );
  }

  private createMessageStream(
    stream: PersistedStreamState,
    delivery: OutgoingMessage["delivery"],
    deliveryFields: Record<string, unknown>,
    outboxKey?: string
  ): MessageStream {
    const path = `v2/users/${encodeURIComponent(stream.conversationId)}/stream_messages`;
    const persist = async (status: PersistedOutboxRecord["status"]) => {
      if (!outboxKey) {
        return;
      }
      await this.setOutbox(outboxKey, {
        status,
        updatedAt: new Date().toISOString(),
        sentCount: stream.nextIndex,
        stream
      });
    };
    const send = async (
      chunk: PersistedStreamChunk,
      terminalState?: "completed" | "aborted"
    ): Promise<SentMessage> => {
      if (stream.state !== "open" && stream.state !== "uncertain") {
        throw new Error(`QQ message stream is ${stream.state}`);
      }
      if (stream.state === "uncertain" && stream.pendingChunk !== chunk) {
        throw new Error("QQ message stream requires retry before continuing");
      }
      stream.pendingChunk = chunk;
      await persist("sending");
      try {
        const receipt = await this.sendStreamChunk(
          path,
          stream.conversationId,
          delivery,
          {
            input_mode: chunk.inputMode,
            input_state: chunk.inputState,
            index: chunk.index,
            content_type: stream.contentType,
            content_raw: chunk.content,
            stream_msg_id: stream.id,
            ...deliveryFields
          }
        );
        stream.currentContent =
          chunk.inputMode === "append"
            ? stream.currentContent + chunk.content
            : chunk.content;
        stream.nextIndex = chunk.index + 1;
        stream.state =
          terminalState ??
          (chunk.inputState === 10 ? "completed" : "open");
        stream.lastReceipt = serializeReceipt(receipt);
        delete stream.pendingChunk;
        await persist(
          stream.state === "completed" || stream.state === "aborted"
            ? "sent"
            : "sending"
        );
        return receipt;
      } catch (error) {
        stream.state = "uncertain";
        if (outboxKey) {
          await this.keepUncertainStream(outboxKey, stream, error);
        }
        throw error;
      }
    };
    const next = async (
      inputMode: "append" | "replace",
      content: string,
      inputState: 1 | 10
    ) => {
      if (stream.state !== "open") {
        throw new Error(`QQ message stream is ${stream.state}`);
      }
      if (inputState === 1 && !content) {
        throw new Error("QQ stream content cannot be empty");
      }
      return send({
        inputMode,
        inputState,
        index: stream.nextIndex,
        content
      });
    };
    return {
      id: stream.id,
      get index() {
        return stream.nextIndex;
      },
      get state(): MessageStreamState {
        return stream.state;
      },
      append: (content) => next("append", content, 1),
      replace: (content) => next("replace", content, 1),
      complete: (content) =>
        next("replace", content ?? stream.currentContent, 10),
      retry: () => {
        if (stream.state !== "uncertain" || !stream.pendingChunk) {
          throw new Error("QQ message stream has no uncertain chunk to retry");
        }
        return send(stream.pendingChunk);
      },
      abort: (content) =>
        send(
          {
            inputMode: "replace",
            inputState: 10,
            index: stream.nextIndex,
            content: content ?? stream.currentContent
          },
          "aborted"
        )
    };
  }

  private async sendStreamChunk(
    path: string,
    conversationId: string,
    delivery: OutgoingMessage["delivery"],
    body: Record<string, unknown>
  ): Promise<SentMessage> {
    const deliveryType = qqDeliveryType(delivery);
    if (deliveryType !== "passive") {
      await this.quota.consumeMessage({
        scope: "direct",
        conversationId,
        deliveryType
      });
    }
    const result = await this.openApi.request<QqMessageResponse>({
      method: "POST",
      path,
      body,
      rateLimitKey: `stream:direct:${conversationId}`
    });
    if (!result?.id) {
      throw new Error("QQ stream response did not include an id");
    }
    return {
      platform: this.name,
      scope: "direct",
      conversationId,
      id: result.id,
      timestamp: this.parseTimestamp(result.timestamp),
      raw: result
    };
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
    const gateway = await this.openApi.request<{ url?: string }>({
      method: "GET",
      path: "gateway",
      idempotent: true
    });
    const gatewayUrl = gateway.url;
    if (!gatewayUrl) {
      throw new Error("QQ gateway response did not include a URL");
    }
    const token = await this.tokens.get();
    this.gatewayMessageQueue = Promise.resolve();
    this.gatewayReady = false;

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
        this.gatewayReady = false;
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
          const ready = payload.d as ReadyData;
          if (ready.session_id) {
            this.sessionId = ready.session_id;
          }
          this.logger.info(
            { sessionId: this.sessionId, resumed: payload.t === "RESUMED" },
            "QQ gateway ready"
          );
          if (payload.t === "RESUMED") {
            this.gatewayMetrics.resumeSuccesses += 1;
          }
          if (this.heartbeatIntervalMs === undefined) {
            throw new Error(
              "QQ gateway became ready before providing a heartbeat interval"
            );
          }
          this.startHeartbeat(this.heartbeatIntervalMs);
          await this.commitSequence(payload.s);
          this.gatewayReady = true;
          markReady();
          return;
        }
        this.gatewayMetrics.receivedEvents += 1;
        {
          const startedAt = Date.now();
          try {
            await this.handleDispatch(payload);
            await this.commitSequence(payload.s);
            this.gatewayMetrics.processedEvents += 1;
          } catch (error) {
            this.gatewayMetrics.failedEvents += 1;
            throw error;
          } finally {
            this.gatewayMetrics.lastProcessingLatencyMs =
              Date.now() - startedAt;
          }
        }
        return;
      case 7:
        this.socket?.close(4000, "server requested reconnect");
        return;
      case 9:
        this.sessionId = undefined;
        this.receivedSequence = null;
        this.processedSequence = null;
        this.gatewayReady = false;
        await this.clearGatewayState();
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

  private enqueueGatewayMessage(
    data: RawData,
    token: string,
    markReady: () => void
  ): Promise<void> {
    const queued = this.gatewayMessageQueue.then(() =>
      this.handleGatewayMessage(data, token, markReady)
    );
    this.gatewayMessageQueue = queued;
    return queued;
  }

  private identifyOrResume(token: string): void {
    if (this.sessionId && this.processedSequence !== null) {
      this.gatewayMetrics.resumeAttempts += 1;
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
        intents: this.intents,
        shard: [0, 1],
        properties: {
          $os: process.platform,
          $browser: "qq-bot",
          $device: "qq-bot"
        }
      }
    });
  }

  private async handleDispatch(payload: GatewayPayload): Promise<void> {
    const event = payload.t;
    const data = payload.d;
    const supported =
      event === "GROUP_AT_MESSAGE_CREATE" ||
      event === "C2C_MESSAGE_CREATE" ||
      (event === "GROUP_MESSAGE_CREATE" && this.receiveAllGroupMessages);
    if (!supported) {
      await this.handleLifecycleDispatch(payload);
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
    const processingDuplicate =
      this.processingMessages.get(deduplicationKey);
    if (processingDuplicate) {
      await processingDuplicate;
      return;
    }

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
    if (!isGroup) {
      await this.quota.noteInteraction(
        conversationId,
        this.parseTimestamp(source.timestamp)
      );
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
      botMentioned: event === "GROUP_AT_MESSAGE_CREATE",
      timestamp: this.parseTimestamp(source.timestamp),
      raw: payload
    };

    const processing = Promise.resolve()
      .then(() => this.onMessage?.(message))
      .then(() => {
        this.rememberMessage(deduplicationKey);
      });
    this.processingMessages.set(deduplicationKey, processing);
    try {
      await processing;
    } finally {
      this.processingMessages.delete(deduplicationKey);
    }
  }

  private async handleLifecycleDispatch(
    payload: GatewayPayload
  ): Promise<void> {
    const type = payload.t ?? "UNKNOWN";
    const source = (payload.d ?? {}) as Record<string, unknown>;
    const timestamp = this.parseTimestamp(source.timestamp);
    const eventId =
      payload.id ??
      (typeof source.id === "string" ? source.id : undefined);
    const userId = firstString(
      source.user_openid,
      source.openid,
      source.member_openid,
      source.id
    );
    const groupId = firstString(source.group_openid, source.group_id);

    if ((type === "FRIEND_ADD" || type === "FRIEND_DEL") && userId) {
      await this.onEvent?.(
        type === "FRIEND_ADD" ? "contact.added" : "contact.removed",
        {
          platform: this.name,
          userId,
          ...(eventId ? { eventId } : {}),
          timestamp,
          raw: payload
        }
      );
      return;
    }

    if (
      (type === "GROUP_ADD_ROBOT" || type === "GROUP_DEL_ROBOT") &&
      groupId
    ) {
      await this.onEvent?.(
        type === "GROUP_ADD_ROBOT"
          ? "bot.conversation.joined"
          : "bot.conversation.left",
        {
          platform: this.name,
          scope: "group",
          conversationId: groupId,
          ...(eventId ? { eventId } : {}),
          timestamp,
          raw: payload
        }
      );
      return;
    }

    const deliveryEnabled =
      type === "C2C_MSG_RECEIVE" || type === "GROUP_MSG_RECEIVE";
    const deliveryDisabled =
      type === "C2C_MSG_REJECT" || type === "GROUP_MSG_REJECT";
    if (deliveryEnabled || deliveryDisabled) {
      const isGroup = type.startsWith("GROUP_");
      const conversationId = isGroup ? groupId : userId;
      if (conversationId) {
        await this.setDeliveryPreference(
          isGroup ? "group" : "direct",
          conversationId,
          deliveryEnabled
        );
        await this.onEvent?.(
          deliveryEnabled
            ? "message.delivery.enabled"
            : "message.delivery.disabled",
          {
            platform: this.name,
            scope: isGroup ? "group" : "direct",
            conversationId,
            enabled: deliveryEnabled,
            ...(eventId ? { eventId } : {}),
            timestamp,
            raw: payload
          }
        );
        return;
      }
    }

    if (type === "INTERACTION_CREATE") {
      const conversationId = groupId ?? userId;
      if (conversationId) {
        await this.onEvent?.("interaction.created", {
          platform: this.name,
          scope: groupId ? "group" : "direct",
          conversationId,
          ...(eventId ? { eventId } : {}),
          ...(typeof source.id === "string"
            ? { interactionId: source.id }
            : {}),
          ...(userId ? { userId } : {}),
          timestamp,
          raw: payload
        });
        return;
      }
    }

    const fallback: PlatformEvent = {
      platform: this.name,
      type,
      ...(eventId ? { eventId } : {}),
      ...(payload.s !== undefined ? { sequence: payload.s } : {}),
      timestamp,
      raw: Object.freeze(payload)
    };
    this.gatewayMetrics.unknownEvents += 1;
    const now = Date.now();
    const warnedAt = this.unknownEventWarnings.get(type) ?? 0;
    if (warnedAt < now - 60_000) {
      this.unknownEventWarnings.set(type, now);
      this.logger.warn(
        { event: type, eventId, sequence: payload.s },
        "unmapped QQ gateway event"
      );
    }
    await this.onEvent?.("platform.event", fallback);
  }

  private async restoreGatewayState(): Promise<void> {
    const state =
      await this.gatewayStateStore?.get<PersistedGatewayState>(
        this.gatewayStateKey()
      );
    if (
      !state ||
      !state.sessionId ||
      !Number.isSafeInteger(state.processedSequence) ||
      state.processedSequence < 0
    ) {
      return;
    }
    this.sessionId = state.sessionId;
    this.processedSequence = state.processedSequence;
    this.receivedSequence = state.processedSequence;
    this.gatewayMetrics.restoredSessions += 1;
  }

  private async commitSequence(sequence: number | undefined): Promise<void> {
    if (sequence === undefined) {
      return;
    }
    if (this.gatewayStateStore && this.sessionId) {
      await this.gatewayStateStore.set<PersistedGatewayState>(
        this.gatewayStateKey(),
        {
          sessionId: this.sessionId,
          processedSequence: sequence
        }
      );
    }
    this.processedSequence = sequence;
  }

  private async clearGatewayState(): Promise<void> {
    await this.gatewayStateStore?.delete(this.gatewayStateKey());
  }

  private async assertDeliveryAllowed(
    message: OutgoingMessage
  ): Promise<void> {
    if (message.delivery.type === "passive") {
      return;
    }
    const enabled = await this.gatewayStateStore?.get<boolean>(
      this.deliveryPreferenceKey(message.scope, message.conversationId)
    );
    if (enabled === false) {
      throw new QqApiError(
        "QQ recipient has disabled active message delivery",
        {
          httpStatus: 403,
          endpoint: "DELIVERY_STATE",
          retryable: false,
          kind: "delivery_rejected"
        }
      );
    }
  }

  private async setDeliveryPreference(
    scope: "group" | "direct",
    conversationId: string,
    enabled: boolean
  ): Promise<void> {
    await this.gatewayStateStore?.set(
      this.deliveryPreferenceKey(scope, conversationId),
      enabled
    );
  }

  private deliveryPreferenceKey(
    scope: OutgoingMessage["scope"],
    conversationId: string
  ): string {
    return [
      "adapter",
      "qq-official",
      this.appId,
      "delivery",
      scope,
      encodeURIComponent(conversationId)
    ].join(":");
  }

  private gatewayStateKey(): string {
    return [
      "adapter",
      "qq-official",
      this.appId,
      "gateway",
      "0"
    ].join(":");
  }

  private outboxKey(idempotencyKey: string): string {
    return [
      "adapter",
      "qq-official",
      this.appId,
      "outbox",
      encodeURIComponent(idempotencyKey)
    ].join(":");
  }

  private async getOutbox(
    key: string
  ): Promise<PersistedOutboxRecord | undefined> {
    return (
      (await this.gatewayStateStore?.get<PersistedOutboxRecord>(key)) ??
      this.outbox.get(key)
    );
  }

  private async reserveOutbox(
    key: string
  ): Promise<{ record: PersistedOutboxRecord; created: boolean }> {
    const pending = (): PersistedOutboxRecord => ({
      status: "pending",
      updatedAt: new Date().toISOString()
    });
    if (!this.gatewayStateStore) {
      const current = this.outbox.get(key);
      if (current) {
        return { record: current, created: false };
      }
      const record = pending();
      this.outbox.set(key, record);
      return { record, created: true };
    }
    let created = false;
    const record = await this.gatewayStateStore.update<PersistedOutboxRecord>(
      key,
      (current) => {
        if (current) {
          return current;
        }
        created = true;
        return pending();
      }
    );
    if (!record) {
      throw new Error("QQ Outbox reservation did not return a record");
    }
    this.outbox.set(key, record);
    return { record, created };
  }

  private async setOutbox(
    key: string,
    record: PersistedOutboxRecord
  ): Promise<void> {
    this.outbox.set(key, record);
    await this.gatewayStateStore?.set(key, record);
  }

  private async keepUncertainOutbox(
    key: string,
    sentCount: number,
    error: unknown
  ): Promise<void> {
    const record: PersistedOutboxRecord = {
      status: "uncertain",
      updatedAt: new Date().toISOString(),
      sentCount,
      error: error instanceof Error ? error.message : String(error)
    };
    this.outbox.set(key, record);
    try {
      await this.gatewayStateStore?.set(key, record);
    } catch (storageError) {
      this.logger.error(
        { error: storageError, outboxKey: key },
        "QQ uncertain outbox state could not be persisted"
      );
    }
  }

  private async keepUncertainStream(
    key: string,
    stream: PersistedStreamState,
    error: unknown
  ): Promise<void> {
    const record: PersistedOutboxRecord = {
      status: "uncertain",
      updatedAt: new Date().toISOString(),
      sentCount: stream.nextIndex,
      error: error instanceof Error ? error.message : String(error),
      stream
    };
    this.outbox.set(key, record);
    try {
      await this.gatewayStateStore?.set(key, record);
    } catch (storageError) {
      this.logger.error(
        { error: storageError, outboxKey: key },
        "QQ uncertain stream state could not be persisted"
      );
    }
  }

  private async deleteOutbox(key: string): Promise<void> {
    this.outbox.delete(key);
    await this.gatewayStateStore?.delete(key);
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
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts, 10)
    );
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts += 1;
    this.gatewayMetrics.reconnects += 1;
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

  private parseTimestamp(value: unknown): Date {
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
      return new Date(milliseconds);
    }
    if (typeof value !== "string" || !value) {
      return new Date();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function digest(
  algorithm: "md5" | "sha1",
  data: Uint8Array
): string {
  return createHash(algorithm).update(data).digest("hex");
}

function serializeReceipt(
  receipt: SentMessage
): Omit<SentMessage, "timestamp"> & { timestamp: string } {
  return {
    ...receipt,
    timestamp: receipt.timestamp.toISOString()
  };
}

function qqDeliveryType(
  delivery: OutgoingMessage["delivery"]
): "passive" | "active" | "wakeup" {
  if (delivery.type === "passive" || delivery.type === "active") {
    return delivery.type;
  }
  if (
    delivery.platform === QQ_PLATFORM &&
    delivery.mode === "wakeup"
  ) {
    return "wakeup";
  }
  throw new Error(
    `QQ adapter does not support ${delivery.platform} delivery mode "${delivery.mode}"`
  );
}

function requireChecksum(
  media: OutgoingMedia,
  algorithm: string,
  bytes?: number
): string {
  if (media.source.type !== "stream") {
    throw new Error("checksums are only available for streaming media");
  }
  const checksum = media.source.checksums.find(
    (candidate) =>
      candidate.algorithm.toLowerCase() === algorithm.toLowerCase() &&
      candidate.bytes === bytes
  );
  if (!checksum) {
    const coverage = bytes === undefined ? "the complete stream" : `the first ${bytes} bytes`;
    throw new Error(
      `${media.type} stream requires a ${algorithm} checksum for ${coverage}`
    );
  }
  return checksum.digest;
}

function validateStreamSource(media: OutgoingMedia): void {
  if (media.source.type !== "stream") {
    return;
  }
  const limit = mediaSizeLimits[media.type];
  if (!Number.isSafeInteger(media.source.size) || media.source.size <= 0) {
    throw new Error(`${media.type} stream size must be a positive integer`);
  }
  if (media.source.size > limit) {
    throw new Error(
      `${media.type} exceeds QQ size limit of ${Math.round(limit / 1024 / 1024)} MiB`
    );
  }
  for (const [name, value, length] of [
    ["md5", requireChecksum(media, "md5"), 32],
    ["sha1", requireChecksum(media, "sha1"), 40],
    [
      "md5_first_10m",
      requireChecksum(media, "md5", QQ_HEAD_CHECKSUM_BYTES),
      32
    ]
  ] as const) {
    if (!new RegExp(`^[a-f0-9]{${length}}$`, "iu").test(value)) {
      throw new Error(`${media.type} stream ${name} must be a hex digest`);
    }
  }
}

class AsyncPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array | undefined;
  private currentOffset = 0;
  private consumed = 0;

  public constructor(
    stream: AsyncIterable<Uint8Array>,
    private readonly expectedSize: number
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  public async read(size: number): Promise<Uint8Array> {
    const remainingExpected = this.expectedSize - this.consumed;
    const output = new Uint8Array(Math.min(size, remainingExpected));
    let written = 0;
    while (written < output.byteLength) {
      if (!this.current || this.currentOffset >= this.current.byteLength) {
        const next = await this.iterator.next();
        if (next.done) {
          throw new Error("QQ media stream ended before its declared size");
        }
        if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
          throw new Error("QQ media stream chunks must be non-empty Uint8Array values");
        }
        this.current = next.value;
        this.currentOffset = 0;
      }
      const available = this.current.byteLength - this.currentOffset;
      const take = Math.min(available, output.byteLength - written);
      output.set(
        this.current.subarray(this.currentOffset, this.currentOffset + take),
        written
      );
      this.currentOffset += take;
      written += take;
      this.consumed += take;
    }
    return output;
  }

  public async assertComplete(): Promise<void> {
    if (
      this.consumed !== this.expectedSize ||
      (this.current && this.currentOffset < this.current.byteLength)
    ) {
      throw new Error("QQ media stream does not match its declared size");
    }
    const next = await this.iterator.next();
    if (!next.done) {
      throw new Error("QQ media stream exceeds its declared size");
    }
  }
}

export { QqApiError } from "./openapi/error.js";
export type { QqApiErrorKind } from "./openapi/error.js";
