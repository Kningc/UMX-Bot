import type {
  Awaitable,
  BotAdapter,
  BotEvents,
  CommandSummary,
  ConversationRef,
  IncomingMessage,
  KeyValueListOptions,
  KeyValueStore,
  Logger,
  MessageKeyboard,
  MessageStream,
  MessageStreamOptions,
  NavigationPageSummary,
  OutgoingMessage,
  PlatformEvent,
  ReplyTarget,
  SentMessage
} from "@umx-bot/plugin-sdk";
import {
  QqMessageDeduplicator,
  type QqMessageDeduplicatorSnapshot
} from "./deduplicator.js";
import { QqGatewayClient } from "./gateway/client.js";
import { resolveIntents } from "./gateway/intents.js";
import { QqGatewaySessionStore } from "./gateway/session-store.js";
import { serializeQqKeyboard } from "./keyboard.js";
import {
  isQqMessageEvent,
  mapIncomingMessage
} from "./mapping/incoming-message.js";
import { mapLifecycleEvent } from "./mapping/lifecycle-events.js";
import { QqMediaUploader } from "./media-uploader.js";
import { createQqMessageStream } from "./message-stream.js";
import {
  QqNavigationSynchronizer,
  type QqNavigationSyncResult
} from "./navigation-sync.js";
import { QqOpenApiClient } from "./openapi/client.js";
import { QqApiError } from "./openapi/error.js";
import { QqOutbox, type QqOutboxEntry } from "./outbox.js";
import {
  describeProtocolShape,
  type GatewayPayload,
  type PersistedOutboxRecord,
  type PersistedStreamState,
  parseQqTimestamp,
  type QqMessage,
  type QqMessageResponse,
  qqDeliveryType,
  serializeReceipt
} from "./protocol.js";
import { type QqCertification, QqQuotaGovernor } from "./quota-governor.js";
import { TokenManager } from "./token-manager.js";

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
  syncNavigationOnStart?: boolean;
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
    lastMessage?: {
      event: string;
      botMentioned: boolean;
      contentLength: number;
      payloadShape: unknown;
    };
  };
  navigation: {
    enabled: boolean;
    lastSyncedAt?: string;
    lastResult?: QqNavigationSyncResult;
  };
  outbox: {
    /**
     * Records this process is holding in memory because persisting them
     * failed. They are lost on restart, so a non-zero value needs an operator.
     */
    unpersisted: number;
  };
  deduplication: QqMessageDeduplicatorSnapshot;
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
  private readonly sessions: QqGatewaySessionStore;
  private readonly tokens: TokenManager;
  private readonly openApi: QqOpenApiClient;
  private readonly navigationSynchronizer: QqNavigationSynchronizer;
  private readonly syncNavigationOnStart: boolean;
  private readonly quota: QqQuotaGovernor;
  private readonly gateway: QqGatewayClient;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private onEvent:
    | (<K extends Exclude<keyof BotEvents, "message.created">>(
        event: K,
        payload: BotEvents[K]
      ) => Awaitable<void>)
    | undefined;
  private stopped = true;
  private lifecycleController: AbortController | undefined;
  private readonly deduplicator: QqMessageDeduplicator;
  private readonly processingMessages = new Map<string, Promise<void>>();
  private readonly unknownEventWarnings = new Map<string, number>();
  private readonly replySequences = new Map<string, number>();
  private readonly outbox: QqOutbox;
  private readonly media: QqMediaUploader;
  private navigationSyncDiagnostics: {
    lastSyncedAt?: string;
    lastResult?: QqNavigationSyncResult;
  } = {};
  private lastMessageDiagnostics:
    | {
        event: string;
        botMentioned: boolean;
        contentLength: number;
        payloadShape: unknown;
      }
    | undefined;

  public constructor(options: QqOfficialAdapterOptions) {
    this.appId = options.appId;
    this.logger = options.logger;
    this.receiveAllGroupMessages = options.receiveAllGroupMessages ?? false;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.bot.qq.com";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.gatewayReadyTimeoutMs = options.gatewayReadyTimeoutMs ?? 15_000;
    this.intents = resolveIntents(options);
    this.gatewayStateStore = options.gatewayStateStore;
    this.sessions = new QqGatewaySessionStore(
      options.appId,
      options.gatewayStateStore,
      this.intents
    );
    this.syncNavigationOnStart = options.syncNavigationOnStart ?? true;
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
    this.navigationSynchronizer = new QqNavigationSynchronizer(
      this.openApi,
      this.logger
    );
    this.outbox = new QqOutbox(
      options.appId,
      options.gatewayStateStore,
      this.logger
    );
    this.media = new QqMediaUploader(this.openApi);
    this.deduplicator = new QqMessageDeduplicator({
      appId: options.appId,
      store: options.gatewayStateStore,
      logger: this.logger.child({ component: "deduplicator" })
    });
    this.gateway = new QqGatewayClient({
      openApi: this.openApi,
      tokens: this.tokens,
      sessions: this.sessions,
      logger: this.logger,
      intents: this.intents,
      readyTimeoutMs: this.gatewayReadyTimeoutMs,
      reconnectDelayMs: this.reconnectDelayMs,
      reconnectMaxDelayMs: this.reconnectMaxDelayMs,
      onDispatch: (payload) => this.handleDispatch(payload)
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
      await this.gateway.start();
      return;
    }

    this.stopped = false;
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.lifecycleController = new AbortController();
    try {
      await this.deduplicator.restore();
      await this.gateway.start();
    } catch (error) {
      this.stopped = true;
      this.lifecycleController.abort();
      this.lifecycleController = undefined;
      this.onMessage = undefined;
      this.onEvent = undefined;
      await this.gateway.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleController?.abort();
    this.lifecycleController = undefined;
    await this.gateway.stop();
    this.onMessage = undefined;
    this.onEvent = undefined;
  }

  public getDiagnostics(): QqOfficialDiagnostics {
    return {
      openApi: this.openApi.getMetrics(),
      gateway: {
        ...this.gateway.diagnostics(),
        ...(this.lastMessageDiagnostics
          ? { lastMessage: structuredClone(this.lastMessageDiagnostics) }
          : {})
      },
      navigation: {
        enabled: this.syncNavigationOnStart,
        ...structuredClone(this.navigationSyncDiagnostics)
      },
      outbox: { unpersisted: this.outbox.unpersistedCount() },
      deduplication: this.deduplicator.snapshot()
    };
  }

  public async syncNavigation(
    pages: readonly NavigationPageSummary[],
    commands?: readonly CommandSummary[]
  ): Promise<void> {
    if (!this.syncNavigationOnStart) return;
    const result = await this.navigationSynchronizer.sync(pages, commands);
    this.navigationSyncDiagnostics = {
      lastSyncedAt: new Date().toISOString(),
      lastResult: result
    };
  }

  public async getDeliveryStatus(
    conversation: ConversationRef
  ): Promise<QqDeliveryStatus> {
    if (conversation.platform !== this.name || conversation.scope === "guild") {
      return "unknown";
    }
    const enabled = await this.gatewayStateStore?.get<boolean>(
      this.deliveryPreferenceKey(
        conversation.scope,
        conversation.conversationId
      )
    );
    return enabled === undefined ? "unknown" : enabled ? "enabled" : "disabled";
  }

  public async getOutboxStatus(
    idempotencyKey: string
  ): Promise<QqOutboxStatus> {
    const record = await this.outbox.get(
      this.outbox.key(idempotencyKey.trim())
    );
    return record?.status ?? "missing";
  }

  /**
   * Lists outbox records, newest state first per key, so an operator can find
   * the `uncertain` ones this adapter refuses to resend by itself.
   *
   * Pass `status` to filter. Throws when the configured store cannot list
   * keys, rather than reporting an empty outbox.
   */
  public async listOutbox(
    options: KeyValueListOptions & {
      status?: PersistedOutboxRecord["status"];
    } = {}
  ): Promise<QqOutboxEntry[]> {
    const { status, ...listOptions } = options;
    const entries = await this.outbox.list(listOptions);
    return status === undefined
      ? entries
      : entries.filter((entry) => entry.record.status === status);
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
    const outboxKey = this.outbox.key(idempotencyKey);
    const reservation = await this.outbox.reserve(outboxKey);
    const current = reservation.record;
    if (!reservation.created && current.status === "sent" && current.receipt) {
      return {
        ...current.receipt,
        timestamp: new Date(current.receipt.timestamp)
      };
    }
    if (!reservation.created && current.status === "sent") {
      // Marked delivered by an operator (`scripts/outbox.mjs resolve`), so
      // there is no receipt to hand back — but it must still not be resent.
      throw new QqApiError(
        "QQ message was marked as delivered by an operator; refusing a resend",
        {
          httpStatus: 0,
          endpoint: "OUTBOX",
          retryable: false,
          kind: "unknown"
        }
      );
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

    await this.outbox.set(outboxKey, {
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
        await this.outbox.keepUncertain(outboxKey, sentCount, error);
      } else {
        await this.outbox.delete(outboxKey);
      }
      throw error;
    }
    try {
      await this.outbox.set(outboxKey, {
        status: "sent",
        updatedAt: new Date().toISOString(),
        receipt: {
          ...receipt,
          timestamp: receipt.timestamp.toISOString()
        }
      });
      return receipt;
    } catch (error) {
      await this.outbox.keepUncertain(outboxKey, Math.max(1, sentCount), error);
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
    if (
      qqDeliveryType(message.delivery) === "wakeup" &&
      message.scope !== "direct"
    ) {
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

    const { text = "", markdown, media = [], keyboard } = message.content;
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
      const receipt = await this.sendMarkdownMessage(message, messageResource, {
        markdown: markdown ?? text,
        ...(keyboard ? { keyboard } : {})
      });
      onMessageSent?.();
      return receipt;
    }

    const receipts: SentMessage[] = [];
    if (text.length > 0 && media[0]?.type !== "image") {
      receipts.push(
        await this.sendMessageBody(
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
        )
      );
      onMessageSent?.();
    }

    for (const [index, item] of media.entries()) {
      const upload = await this.media.upload(
        fileResource,
        item,
        message.conversationId,
        message.scope
      );
      const content = index === 0 && item.type === "image" ? text : "";
      receipts.push(
        await this.sendMessageBody(
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
        )
      );
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
          ? { keyboard: serializeQqKeyboard(content.keyboard) }
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

  private messageReference(message: OutgoingMessage): Record<string, unknown> {
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
      timestamp: parseQqTimestamp(result.timestamp),
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
    if (
      conversation.platform !== this.name ||
      conversation.scope !== "direct"
    ) {
      throw new Error("QQ typing status is only supported for direct chats");
    }
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
      throw new Error(
        "QQ typing duration must be an integer from 1 to 60 seconds"
      );
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
    if (!this.gateway.isReady) {
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
        : this.outbox.key(options.delivery.idempotencyKey.trim());
    if (outboxKey) {
      const reservation = await this.outbox.reserve(outboxKey);
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
      await this.outbox.set(outboxKey, {
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
          await this.outbox.delete(outboxKey);
        } else {
          await this.outbox.keepUncertain(outboxKey, 0, error);
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
        await this.outbox.set(outboxKey, {
          status: "sending",
          updatedAt: new Date().toISOString(),
          sentCount: 1,
          stream
        });
      } catch (error) {
        stream.state = "uncertain";
        await this.outbox.keepUncertainStream(outboxKey, stream, error);
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
    return createQqMessageStream(stream, delivery, deliveryFields, {
      outbox: this.outbox,
      ...(outboxKey ? { outboxKey } : {}),
      sendChunk: (path, conversationId, chunkDelivery, body) =>
        this.sendStreamChunk(path, conversationId, chunkDelivery, body)
    });
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
      timestamp: parseQqTimestamp(result.timestamp),
      raw: result
    };
  }

  private async handleDispatch(payload: GatewayPayload): Promise<void> {
    const event = payload.t;
    if (!isQqMessageEvent(event, this.receiveAllGroupMessages)) {
      await this.handleLifecycleDispatch(payload);
      return;
    }

    const mapped = mapIncomingMessage(payload, event, {
      platform: this.name
    });
    if (!mapped.ok) {
      this.logger.warn(
        { event, reason: mapped.reason },
        mapped.reason === "malformed"
          ? "ignored malformed QQ message event"
          : "QQ message is missing OpenID fields"
      );
      return;
    }

    const { message, deduplicationKey } = mapped;
    if (await this.deduplicator.has(deduplicationKey)) {
      return;
    }
    const processingDuplicate = this.processingMessages.get(deduplicationKey);
    if (processingDuplicate) {
      await processingDuplicate;
      return;
    }

    if (message.scope === "direct") {
      // The recall window for active messages is measured from the user's own
      // last interaction, so every direct message refreshes the ledger.
      await this.quota.noteInteraction(
        message.conversationId,
        message.timestamp
      );
    }

    this.lastMessageDiagnostics = {
      event: event ?? "UNKNOWN",
      botMentioned: message.botMentioned ?? false,
      contentLength: message.content.length,
      payloadShape: describeProtocolShape(payload.d as QqMessage)
    };

    const processing = Promise.resolve()
      .then(() => this.onMessage?.(message))
      .finally(async () => {
        await this.deduplicator.remember(deduplicationKey);
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
    const mapped = mapLifecycleEvent(payload, { platform: this.name });
    if (mapped.kind === "unmapped") {
      await this.emitUnmappedEvent(mapped.type, mapped.payload, payload.s);
      return;
    }
    if (mapped.kind === "delivery") {
      // Persisted before the event is emitted, so a plugin that reacts by
      // sending something already sees the new preference.
      await this.setDeliveryPreference(
        mapped.preference.scope,
        mapped.preference.conversationId,
        mapped.preference.enabled
      );
    }
    await this.onEvent?.(mapped.event, mapped.payload);
    if (mapped.kind === "interaction" && mapped.payload.interactionId) {
      await this.acknowledgeInteraction(mapped.payload.interactionId);
    }
  }

  /**
   * Tells QQ the button press was received. Without it the client keeps
   * showing a loading state on the button. Best effort: the press itself was
   * already delivered, so a failed ack is only logged.
   */
  private async acknowledgeInteraction(interactionId: string): Promise<void> {
    try {
      await this.openApi.request<void>({
        method: "PUT",
        path: `interactions/${encodeURIComponent(interactionId)}`,
        body: { code: 0 },
        idempotent: true,
        rateLimitKey: "interaction-ack"
      });
    } catch (error) {
      this.logger.warn({ error, interactionId }, "interaction ack failed");
    }
  }

  private async emitUnmappedEvent(
    type: string,
    event: PlatformEvent,
    sequence: number | undefined
  ): Promise<void> {
    this.gateway.noteUnmappedEvent();
    // Rate-limited so a flood of one unknown type cannot swamp the log.
    const now = Date.now();
    const warnedAt = this.unknownEventWarnings.get(type) ?? 0;
    if (warnedAt < now - 60_000) {
      this.unknownEventWarnings.set(type, now);
      this.logger.warn(
        { event: type, eventId: event.eventId, sequence },
        "unmapped QQ gateway event"
      );
    }
    await this.onEvent?.("platform.event", event);
  }

  private async assertDeliveryAllowed(message: OutgoingMessage): Promise<void> {
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
}

export type {
  QqCommandPanel,
  QqNavigationProjection
} from "./navigation-sync.js";
export {
  projectCommandPanel,
  projectQqNavigation
} from "./navigation-sync.js";
export type { QqApiErrorKind } from "./openapi/error.js";
export { QqApiError } from "./openapi/error.js";
export type { QqOutboxEntry } from "./outbox.js";
