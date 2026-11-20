import type {
  MessageStream,
  MessageStreamState,
  OutgoingMessage,
  SentMessage
} from "@qq-bot/plugin-sdk";
import type { QqOutbox } from "./outbox.js";
import {
  serializeReceipt,
  type PersistedOutboxRecord,
  type PersistedStreamChunk,
  type PersistedStreamState
} from "./protocol.js";

export interface QqMessageStreamDependencies {
  outbox: QqOutbox;
  outboxKey?: string;
  sendChunk(
    path: string,
    conversationId: string,
    delivery: OutgoingMessage["delivery"],
    body: Record<string, unknown>
  ): Promise<SentMessage>;
}

export function createQqMessageStream(
  stream: PersistedStreamState,
  delivery: OutgoingMessage["delivery"],
  deliveryFields: Record<string, unknown>,
  dependencies: QqMessageStreamDependencies
): MessageStream {
  const { outbox, outboxKey, sendChunk } = dependencies;
  const path = `v2/users/${encodeURIComponent(stream.conversationId)}/stream_messages`;
  const persist = async (status: PersistedOutboxRecord["status"]) => {
    if (!outboxKey) {
      return;
    }
    await outbox.set(outboxKey, {
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
      const receipt = await sendChunk(
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
        await outbox.keepUncertainStream(outboxKey, stream, error);
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
