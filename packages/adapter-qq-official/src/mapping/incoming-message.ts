import type { IncomingMessage, MemberRole } from "@qq-bot/plugin-sdk";
import {
  type GatewayPayload,
  mapQqAttachments,
  parseQqTimestamp,
  QQ_MESSAGE_TYPE_QUOTE,
  type QqMessage
} from "../protocol.js";

export const QQ_MESSAGE_EVENTS = [
  "GROUP_AT_MESSAGE_CREATE",
  "C2C_MESSAGE_CREATE",
  "GROUP_MESSAGE_CREATE"
] as const;

export type QqMessageEvent = (typeof QQ_MESSAGE_EVENTS)[number];

export type MapIncomingMessageResult =
  | { ok: true; message: IncomingMessage; deduplicationKey: string }
  | { ok: false; reason: "malformed" | "missing-openid" };

/**
 * Normalizes a QQ message dispatch into the platform-neutral message model.
 *
 * Pure on purpose: every field that plugins see is decided here, so the
 * mapping can be tested against captured event payloads without a socket, a
 * token or a store.
 */
export function mapIncomingMessage(
  payload: GatewayPayload,
  event: QqMessageEvent,
  context: { platform: string }
): MapIncomingMessageResult {
  const source = payload.d as QqMessage;
  if (!source?.id || !source.author) {
    return { ok: false, reason: "malformed" };
  }

  const isGroup = event !== "C2C_MESSAGE_CREATE";
  const authorId = isGroup
    ? (source.author.member_openid ?? source.author.id)
    : (source.author.user_openid ?? source.author.id);
  const conversationId = isGroup
    ? source.group_openid
    : (source.author.user_openid ?? source.author.id);
  if (!authorId || !conversationId) {
    return { ok: false, reason: "missing-openid" };
  }

  const message: IncomingMessage = {
    id: source.id,
    platform: context.platform,
    scope: isGroup ? "group" : "direct",
    conversationId,
    author: {
      id: authorId,
      ...(source.author.username ? { name: source.author.username } : {}),
      role: normalizeRole(source.author.member_role)
    },
    content: source.content?.trim() ?? "",
    attachments: mapQqAttachments(source.attachments),
    mentions: (source.mentions ?? []).flatMap((mention) => {
      const id = mention.member_openid ?? mention.user_openid ?? mention.id;
      const name = mention.username ?? mention.nickname;
      return id ? [{ id, ...(name ? { name } : {}) }] : [];
    }),
    ...(source.message_type === QQ_MESSAGE_TYPE_QUOTE
      ? {
          quote: {
            content: source.msg_elements?.[0]?.content ?? "",
            attachments: mapQqAttachments(
              source.msg_elements?.[0]?.attachments
            ),
            ...(source.msg_elements?.[0]?.msg_idx
              ? { referenceId: source.msg_elements[0].msg_idx }
              : {})
          }
        }
      : {}),
    botMentioned:
      source.mentions?.some((mention) => mention.is_you === true) === true,
    timestamp: parseQqTimestamp(source.timestamp),
    raw: payload
  };

  return {
    ok: true,
    message,
    // `msg_seq` distinguishes the repeats QQ sends for one logical message.
    deduplicationKey: `${source.id}:${source.msg_seq ?? 0}`
  };
}

export function normalizeRole(role: string | undefined): MemberRole {
  return role === "owner" || role === "admin" ? role : "member";
}

/** True when this dispatch carries a user message this adapter handles. */
export function isQqMessageEvent(
  event: string | undefined,
  receiveAllGroupMessages: boolean
): event is QqMessageEvent {
  return (
    event === "GROUP_AT_MESSAGE_CREATE" ||
    event === "C2C_MESSAGE_CREATE" ||
    (event === "GROUP_MESSAGE_CREATE" && receiveAllGroupMessages)
  );
}
