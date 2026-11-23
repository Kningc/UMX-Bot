import type { IncomingMessage } from "@umx-bot/plugin-sdk";

export interface ReplyWindowOptions {
  /** How long a delivered message can still be replied to. Default 10 min. */
  ttlMs?: number;
  /** Messages remembered per conversation. Default 64. */
  perConversation?: number;
  /** Messages remembered overall; the least recently used conversation goes first. Default 1024. */
  total?: number;
  now?: () => number;
}

interface Entry {
  message: IncomingMessage;
  at: number;
}

/**
 * The messages a remote plugin may still reply to.
 *
 * Windows are kept per conversation, so a busy group cannot push a slow
 * reply's message out of the window of a quiet one, and every entry also
 * expires after a time limit (platforms stop accepting passive replies after a
 * few minutes anyway).
 */
export class ReplyWindow {
  private readonly ttlMs: number;
  private readonly perConversation: number;
  private readonly total: number;
  private readonly now: () => number;
  /** Insertion order doubles as least-recently-used order. */
  private readonly conversations = new Map<string, Map<string, Entry>>();
  private readonly index = new Map<string, string>();
  private count = 0;

  public constructor(options: ReplyWindowOptions = {}) {
    this.ttlMs = options.ttlMs ?? 600_000;
    this.perConversation = options.perConversation ?? 64;
    this.total = options.total ?? 1024;
    this.now = options.now ?? Date.now;
  }

  public remember(message: IncomingMessage): void {
    const key = conversationKey(message);
    let entries = this.conversations.get(key);
    if (entries) {
      // Touch: move the conversation to the most recently used end.
      this.conversations.delete(key);
    } else {
      entries = new Map();
    }
    this.conversations.set(key, entries);
    if (entries.delete(message.id)) {
      this.count -= 1;
    }
    entries.set(message.id, { message, at: this.now() });
    this.index.set(message.id, key);
    this.count += 1;
    while (entries.size > this.perConversation) {
      this.dropOldest(entries);
    }
    while (this.count > this.total) {
      const [oldestKey, oldest] = this.conversations.entries().next().value as [
        string,
        Map<string, Entry>
      ];
      this.dropOldest(oldest);
      if (oldest.size === 0) {
        this.conversations.delete(oldestKey);
      }
    }
  }

  /** The message, or undefined when unknown, evicted or expired. */
  public get(id: string): IncomingMessage | undefined {
    const key = this.index.get(id);
    const entry = key ? this.conversations.get(key)?.get(id) : undefined;
    if (!entry) {
      return undefined;
    }
    if (this.now() - entry.at > this.ttlMs) {
      return undefined;
    }
    return entry.message;
  }

  public get size(): number {
    return this.count;
  }

  private dropOldest(entries: Map<string, Entry>): void {
    const [id] = entries.keys();
    if (id !== undefined) {
      entries.delete(id);
      this.index.delete(id);
      this.count -= 1;
    }
  }
}

function conversationKey(message: IncomingMessage): string {
  return `${message.platform}\u0000${message.scope}\u0000${message.conversationId}`;
}
