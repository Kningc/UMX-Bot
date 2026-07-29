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
import WebSocket, { type RawData } from "ws";
import { QqOpenApiClient } from "./openapi/client.js";
import { QqApiError } from "./openapi/error.js";
import { TokenManager } from "./token-manager.js";

const GROUP_AND_C2C_EVENT = 1 << 25;
const INTERACTION_EVENT = 1 << 26;

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
  status: "pending" | "sent";
  updatedAt: string;
  receipt?: Omit<SentMessage, "timestamp"> & { timestamp: string };
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
}

export interface QqOfficialDiagnostics extends Record<string, unknown> {
  openApi: ReturnType<QqOpenApiClient["getMetrics"]>;
  gateway: {
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
export type QqOutboxStatus = "pending" | "sent" | "missing";

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
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatIntervalMs: number | undefined;
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
    const current = await this.getOutbox(outboxKey);
    if (current?.status === "sent" && current.receipt) {
      return {
        ...current.receipt,
        timestamp: new Date(current.receipt.timestamp)
      };
    }
    if (current?.status === "pending") {
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
      status: "pending",
      updatedAt: new Date().toISOString()
    });
    try {
      const receipt = await this.sendInternal(message);
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
      if (error instanceof QqApiError && error.httpStatus === 0) {
        throw error;
      }
      await this.deleteOutbox(outboxKey);
      throw error;
    }
  }

  private async sendInternal(message: OutgoingMessage): Promise<SentMessage> {
    if (message.scope === "guild") {
      throw new Error("guild messages are not implemented by this adapter yet");
    }
    if (message.delivery.type === "wakeup" && message.scope !== "direct") {
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
      return this.sendMessageBody(
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
      return this.sendMarkdownMessage(
        message,
        messageResource,
        {
          markdown: markdown ?? text,
          ...(keyboard ? { keyboard } : {})
        }
      );
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
    if ("templateId" in keyboard) {
      const templateId = keyboard.templateId.trim();
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
              const permission = button.allowedUserIds?.length
                ? {
                    type: 0,
                    specify_user_ids: [...button.allowedUserIds]
                  }
                : { type: button.administratorsOnly ? 1 : 2 };
              return {
                id: button.id ?? `${rowIndex + 1}-${buttonIndex + 1}`,
                render_data: {
                  label,
                  visited_label: button.visitedLabel ?? label,
                  style: button.style ?? 0
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
    if (delivery.type === "active") {
      return body;
    }
    if (delivery.type === "wakeup") {
      return { ...body, is_wakeup: true };
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
        : digest("sha1", media.source.data);
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
    data: Uint8Array,
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
    const prepare = await this.openApi.request<QqUploadPrepareResponse>({
      method: "POST",
      path: prepareResource,
      body: {
        file_type: qqMediaTypes[media.type],
        file_size: String(data.byteLength),
        file_name: filename,
        md5: digest("md5", data),
        sha1: digest("sha1", data),
        md5_10m: digest("md5", data.subarray(0, 10_002_432))
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
      const chunk = data.subarray(
        offset,
        Math.min(offset + requestedSize, data.byteLength)
      );
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
    if (offset !== data.byteLength) {
      throw new Error("QQ multipart prepare did not cover the whole file");
    }
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
    const result = await this.openApi.request<QqMessageResponse>({
      method: "POST",
      path: resource,
      body,
      rateLimitKey: [
        "message",
        message.scope,
        message.conversationId,
        message.delivery.type
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
    const first = await this.sendStreamChunk(
      path,
      options.conversation.conversationId,
      {
        input_mode: options.inputMode ?? "replace",
        input_state: 1,
        index: 0,
        content_type: options.contentType,
        content_raw: options.initialContent,
        ...deliveryFields
      }
    );
    const streamId = first.id;
    let nextIndex = 1;
    let state: MessageStreamState = "open";
    let currentContent = options.initialContent;

    const sendChunk = async (
      inputMode: "append" | "replace",
      content: string,
      inputState: 1 | 10
    ): Promise<SentMessage> => {
      if (state !== "open") {
        throw new Error(`QQ message stream is ${state}`);
      }
      if (inputState === 1 && !content) {
        throw new Error("QQ stream content cannot be empty");
      }
      try {
        const receipt = await this.sendStreamChunk(
          path,
          options.conversation.conversationId,
          {
            input_mode: inputMode,
            input_state: inputState,
            index: nextIndex,
            content_type: options.contentType,
            content_raw: content,
            stream_msg_id: streamId,
            ...deliveryFields
          }
        );
        nextIndex += 1;
        currentContent =
          inputMode === "append" ? currentContent + content : content;
        if (inputState === 10) {
          state = "completed";
        }
        return receipt;
      } catch (error) {
        state = "failed";
        throw error;
      }
    };

    return {
      id: streamId,
      get index() {
        return nextIndex;
      },
      get state() {
        return state;
      },
      append: (content) => sendChunk("append", content, 1),
      replace: (content) => sendChunk("replace", content, 1),
      complete: (content) =>
        sendChunk("replace", content ?? currentContent, 10)
    };
  }

  private async sendStreamChunk(
    path: string,
    conversationId: string,
    body: Record<string, unknown>
  ): Promise<SentMessage> {
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

  private async setOutbox(
    key: string,
    record: PersistedOutboxRecord
  ): Promise<void> {
    this.outbox.set(key, record);
    await this.gatewayStateStore?.set(key, record);
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

export { QqApiError } from "./openapi/error.js";
export type { QqApiErrorKind } from "./openapi/error.js";
