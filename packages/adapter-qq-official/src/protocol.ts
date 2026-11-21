import { createHash } from "node:crypto";
import type {
  IncomingMessage,
  OutgoingMedia,
  OutgoingMessage,
  SentMessage
} from "@qq-bot/plugin-sdk";
import { QQ_PLATFORM } from "@qq-bot/plugin-sdk-qq";

export const GROUP_AND_C2C_EVENT = 1 << 25;
export const INTERACTION_EVENT = 1 << 26;
export const QQ_MESSAGE_TYPE_QUOTE = 103;
export const qqButtonStyles = {
  default: 0,
  primary: 1,
  success: 2,
  danger: 3
} as const;

export interface GatewayPayload {
  id?: string;
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QqAuthor {
  id?: string;
  username?: string;
  nickname?: string;
  member_openid?: string;
  user_openid?: string;
  member_role?: string;
  bot?: boolean;
  is_you?: boolean;
}

export interface QqMessage {
  id?: string;
  msg_seq?: number;
  content?: string;
  group_openid?: string;
  timestamp?: string;
  author?: QqAuthor;
  attachments?: QqAttachment[];
  mentions?: QqAuthor[];
  message_type?: number;
  msg_elements?: QqMessageElement[];
}

export interface QqMessageElement {
  msg_idx?: string;
  message_type?: number;
  content?: string;
  attachments?: QqAttachment[];
  msg_elements?: QqMessageElement[];
}

export interface QqAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

export function mapQqAttachments(
  attachments: QqAttachment[] | undefined
): IncomingMessage["attachments"] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.url
      ? [
          {
            url: attachment.url,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
            ...(attachment.content_type
              ? { contentType: attachment.content_type }
              : {}),
            ...(attachment.size !== undefined ? { size: attachment.size } : {}),
            ...(attachment.width !== undefined
              ? { width: attachment.width }
              : {}),
            ...(attachment.height !== undefined
              ? { height: attachment.height }
              : {})
          }
        ]
      : []
  );
}

export interface ReadyData {
  session_id?: string;
}

export interface QqMediaUploadResponse {
  file_info?: string;
  file_uuid?: string;
  ttl?: number;
}

export interface QqUploadPrepareResponse {
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

export interface QqMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: unknown;
  remain_msg_len?: number;
}

export interface PersistedGatewayState {
  sessionId: string;
  processedSequence: number;
  /**
   * Intents the session was identified with. A Resume keeps the intents of the
   * original Identify, so a session must not outlive a change to them.
   * Absent in state written by older versions.
   */
  intents?: number;
}

export interface PersistedOutboxRecord {
  status: "pending" | "sending" | "sent" | "uncertain";
  updatedAt: string;
  receipt?: Omit<SentMessage, "timestamp"> & { timestamp: string };
  sentCount?: number;
  error?: string;
  stream?: PersistedStreamState;
}

export interface PersistedStreamChunk {
  inputMode: "append" | "replace";
  inputState: 1 | 10;
  index: number;
  content: string;
}

export interface PersistedStreamState {
  id: string;
  conversationId: string;
  contentType: "text" | "markdown";
  currentContent: string;
  nextIndex: number;
  state: "open" | "completed" | "uncertain" | "aborted";
  pendingChunk?: PersistedStreamChunk;
  lastReceipt: Omit<SentMessage, "timestamp"> & { timestamp: string };
}

export const qqMediaTypes: Record<OutgoingMedia["type"], number> = {
  image: 1,
  video: 2,
  audio: 3,
  file: 4
};

export const mediaSizeLimits: Record<OutgoingMedia["type"], number> = {
  image: 200 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  file: 200 * 1024 * 1024
};
export const multipartThreshold = 5 * 1024 * 1024;

export function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

export function digest(algorithm: "md5" | "sha1", data: Uint8Array): string {
  return createHash(algorithm).update(data).digest("hex");
}

export function serializeReceipt(
  receipt: SentMessage
): Omit<SentMessage, "timestamp"> & { timestamp: string } {
  return {
    ...receipt,
    timestamp: receipt.timestamp.toISOString()
  };
}

export function qqDeliveryType(
  delivery: OutgoingMessage["delivery"]
): "passive" | "active" | "wakeup" {
  if (delivery.type === "passive" || delivery.type === "active") {
    return delivery.type;
  }
  if (delivery.platform === QQ_PLATFORM && delivery.mode === "wakeup") {
    return "wakeup";
  }
  throw new Error(
    `QQ adapter does not support ${delivery.platform} delivery mode "${delivery.mode}"`
  );
}

const visibleProtocolValueKeys = new Set([
  "bot",
  "element_type",
  "is_you",
  "message_type",
  "scope",
  "source",
  "type"
]);

export function describeProtocolShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (depth >= 8) return "max-depth";
  if (Array.isArray(value)) {
    const uniqueItems = new Map<string, unknown>();
    for (const item of value) {
      const shape = describeProtocolShape(item, depth + 1);
      const key = JSON.stringify(shape);
      if (!uniqueItems.has(key)) uniqueItems.set(key, shape);
      if (uniqueItems.size >= 8) break;
    }
    return {
      type: "array",
      length: value.length,
      itemShapes: [...uniqueItems.values()]
    };
  }
  if (typeof value !== "object") return typeof value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        visibleProtocolValueKeys.has(key) &&
        (typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean")
          ? item
          : describeProtocolShape(item, depth + 1)
      ])
  );
}

export function parseQqTimestamp(value: unknown): Date {
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
