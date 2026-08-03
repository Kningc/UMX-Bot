import { BotKernel } from "@qq-bot/core";
import type { PluginLoadOptions } from "@qq-bot/core";
import type {
  Awaitable,
  BotAdapter,
  BotEvents,
  BotPlugin,
  ChatScope,
  ConversationRef,
  IncomingMessage,
  KeyValueStore,
  Logger,
  MessageStream,
  MessageStreamOptions,
  MemberRole,
  OutgoingMessage,
  ReplyTarget,
  SentMessage
} from "@qq-bot/plugin-sdk";

export interface TestMessageOptions {
  id?: string;
  authorId?: string;
  authorName?: string;
  role?: MemberRole;
  platform?: string;
  scope?: ChatScope;
  conversationId?: string;
  attachments?: IncomingMessage["attachments"];
  mentions?: IncomingMessage["mentions"];
  quote?: IncomingMessage["quote"];
  botMentioned?: boolean;
  timestamp?: Date;
  raw?: unknown;
}

export interface PluginTestHostOptions {
  commandPrefix?: string;
  logger?: Logger;
  store?: KeyValueStore;
  adapterCapabilities?: {
    recall?: (message: SentMessage) => Promise<void>;
    setTyping?: (
      conversation: ConversationRef,
      seconds: number,
      target: ReplyTarget
    ) => Promise<void>;
    openMessageStream?: (
      options: MessageStreamOptions
    ) => Promise<MessageStream>;
  };
}

class SilentLogger implements Logger {
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

class TestAdapter implements BotAdapter {
  public readonly name = "test";
  public readonly sent: OutgoingMessage[] = [];
  public readonly recall?: (message: SentMessage) => Promise<void>;
  public readonly setTyping?: (
    conversation: ConversationRef,
    seconds: number,
    target: ReplyTarget
  ) => Promise<void>;
  public readonly openMessageStream?: (
    options: MessageStreamOptions
  ) => Promise<MessageStream>;
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private onEvent:
    | (<K extends Exclude<keyof BotEvents, "message.created">>(
        event: K,
        payload: BotEvents[K]
      ) => Awaitable<void>)
    | undefined;
  private nextMessageId = 1;

  public constructor(
    capabilities: PluginTestHostOptions["adapterCapabilities"] = {}
  ) {
    if (capabilities.recall) {
      this.recall = capabilities.recall;
    }
    if (capabilities.setTyping) {
      this.setTyping = capabilities.setTyping;
    }
    if (capabilities.openMessageStream) {
      this.openMessageStream = capabilities.openMessageStream;
    }
  }

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>,
    onEvent?: <K extends Exclude<keyof BotEvents, "message.created">>(
      event: K,
      payload: BotEvents[K]
    ) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
    this.onEvent = onEvent;
  }

  public async stop(): Promise<void> {
    this.onMessage = undefined;
    this.onEvent = undefined;
  }

  public async send(message: OutgoingMessage): Promise<SentMessage> {
    this.sent.push(message);
    return {
      platform: this.name,
      scope: message.scope,
      conversationId: message.conversationId,
      id: `sent-${this.sent.length}`,
      timestamp: new Date()
    };
  }

  public async receive(
    content: string,
    options: TestMessageOptions = {}
  ): Promise<void> {
    if (!this.onMessage) {
      throw new Error("plugin test host is not started");
    }
    const author: IncomingMessage["author"] = {
      id: options.authorId ?? "user-1",
      role: options.role ?? "member",
      ...(options.authorName ? { name: options.authorName } : {})
    };
    await this.onMessage({
      id: options.id ?? `message-${this.nextMessageId++}`,
      platform: options.platform ?? this.name,
      scope: options.scope ?? "group",
      conversationId: options.conversationId ?? "conversation-1",
      author,
      content,
      attachments: structuredClone(options.attachments ?? []),
      mentions: structuredClone(options.mentions ?? []),
      ...(options.quote !== undefined
        ? { quote: structuredClone(options.quote) }
        : {}),
      ...(options.botMentioned !== undefined
        ? { botMentioned: options.botMentioned }
        : {}),
      timestamp: options.timestamp
        ? new Date(options.timestamp)
        : new Date(),
      ...(options.raw !== undefined ? { raw: options.raw } : {})
    });
  }

  public async emit<K extends Exclude<keyof BotEvents, "message.created">>(
    event: K,
    payload: BotEvents[K]
  ): Promise<void> {
    if (!this.onEvent) {
      throw new Error("plugin test host is not started");
    }
    await this.onEvent(event, payload);
  }
}

export class PluginTestHost {
  private readonly adapter: TestAdapter;
  private readonly kernel: BotKernel;
  private sentCursor = 0;

  public constructor(options: PluginTestHostOptions = {}) {
    this.adapter = new TestAdapter(options.adapterCapabilities);
    this.kernel = new BotKernel({
      adapter: this.adapter,
      logger: options.logger ?? new SilentLogger(),
      ...(options.store ? { store: options.store } : {}),
      ...(options.commandPrefix
        ? { commandPrefix: options.commandPrefix }
        : {})
    });
  }

  public load(
    plugin: BotPlugin,
    options?: PluginLoadOptions
  ): Promise<void> {
    return this.kernel.load(plugin, options);
  }

  public start(): Promise<void> {
    return this.kernel.start();
  }

  public stop(): Promise<void> {
    return this.kernel.stop();
  }

  public async receive(
    content: string,
    options?: TestMessageOptions
  ): Promise<OutgoingMessage[]> {
    await this.adapter.receive(content, options);
    const messages = this.adapter.sent
      .slice(this.sentCursor)
      .map((message) => ({ ...message }));
    this.sentCursor = this.adapter.sent.length;
    return messages;
  }

  public emit<K extends Exclude<keyof BotEvents, "message.created">>(
    event: K,
    payload: BotEvents[K]
  ): Promise<void> {
    return this.adapter.emit(event, payload);
  }

  public getHealth() {
    return this.kernel.getHealth();
  }
}

export function createPluginTestHost(
  options: PluginTestHostOptions = {}
): PluginTestHost {
  return new PluginTestHost(options);
}
