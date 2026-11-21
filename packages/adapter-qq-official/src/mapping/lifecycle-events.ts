import type {
  BotConversationEvent,
  ContactEvent,
  DeliveryPreferenceEvent,
  InteractionEvent,
  PlatformEvent
} from "@qq-bot/plugin-sdk";
import {
  firstString,
  type GatewayPayload,
  parseQqTimestamp
} from "../protocol.js";

export interface DeliveryPreferenceChange {
  scope: "group" | "direct";
  conversationId: string;
  enabled: boolean;
}

/**
 * A non-message dispatch, translated into the platform-neutral event model.
 *
 * `unmapped` is deliberately a first-class outcome rather than a silent drop:
 * QQ keeps adding event types, and an unknown one must still reach plugins as
 * `platform.event` and show up in the metrics.
 */
export type QqLifecycleMapping =
  | {
      kind: "contact";
      event: "contact.added" | "contact.removed";
      payload: ContactEvent;
    }
  | {
      kind: "conversation";
      event: "bot.conversation.joined" | "bot.conversation.left";
      payload: BotConversationEvent;
    }
  | {
      kind: "delivery";
      event: "message.delivery.enabled" | "message.delivery.disabled";
      payload: DeliveryPreferenceEvent;
      /** The adapter persists this so active sends can be refused early. */
      preference: DeliveryPreferenceChange;
    }
  | {
      kind: "interaction";
      event: "interaction.created";
      payload: InteractionEvent;
    }
  | { kind: "unmapped"; type: string; payload: PlatformEvent };

export function mapLifecycleEvent(
  payload: GatewayPayload,
  context: { platform: string }
): QqLifecycleMapping {
  const platform = context.platform;
  const type = payload.t ?? "UNKNOWN";
  const source = (payload.d ?? {}) as Record<string, unknown>;
  const timestamp = parseQqTimestamp(source.timestamp);
  const eventId =
    payload.id ?? (typeof source.id === "string" ? source.id : undefined);
  const userId = firstString(
    source.user_openid,
    source.openid,
    source.member_openid,
    source.id
  );
  const groupId = firstString(source.group_openid, source.group_id);

  if ((type === "FRIEND_ADD" || type === "FRIEND_DEL") && userId) {
    return {
      kind: "contact",
      event: type === "FRIEND_ADD" ? "contact.added" : "contact.removed",
      payload: {
        platform,
        userId,
        ...(eventId ? { eventId } : {}),
        timestamp,
        raw: payload
      }
    };
  }

  if ((type === "GROUP_ADD_ROBOT" || type === "GROUP_DEL_ROBOT") && groupId) {
    return {
      kind: "conversation",
      event:
        type === "GROUP_ADD_ROBOT"
          ? "bot.conversation.joined"
          : "bot.conversation.left",
      payload: {
        platform,
        scope: "group",
        conversationId: groupId,
        ...(eventId ? { eventId } : {}),
        timestamp,
        raw: payload
      }
    };
  }

  const deliveryEnabled =
    type === "C2C_MSG_RECEIVE" || type === "GROUP_MSG_RECEIVE";
  const deliveryDisabled =
    type === "C2C_MSG_REJECT" || type === "GROUP_MSG_REJECT";
  if (deliveryEnabled || deliveryDisabled) {
    const isGroup = type.startsWith("GROUP_");
    const conversationId = isGroup ? groupId : userId;
    if (conversationId) {
      const scope = isGroup ? "group" : "direct";
      return {
        kind: "delivery",
        event: deliveryEnabled
          ? "message.delivery.enabled"
          : "message.delivery.disabled",
        payload: {
          platform,
          scope,
          conversationId,
          enabled: deliveryEnabled,
          ...(eventId ? { eventId } : {}),
          timestamp,
          raw: payload
        },
        preference: { scope, conversationId, enabled: deliveryEnabled }
      };
    }
  }

  if (type === "INTERACTION_CREATE") {
    const conversationId = groupId ?? userId;
    if (conversationId) {
      return {
        kind: "interaction",
        event: "interaction.created",
        payload: {
          platform,
          scope: groupId ? "group" : "direct",
          conversationId,
          ...(eventId ? { eventId } : {}),
          ...(typeof source.id === "string"
            ? { interactionId: source.id }
            : {}),
          ...(userId ? { userId } : {}),
          timestamp,
          raw: payload
        }
      };
    }
  }

  return {
    kind: "unmapped",
    type,
    payload: {
      platform,
      type,
      ...(eventId ? { eventId } : {}),
      ...(payload.s !== undefined ? { sequence: payload.s } : {}),
      timestamp,
      raw: Object.freeze(payload)
    }
  };
}
