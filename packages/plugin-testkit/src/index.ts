import { BotKernel } from "@qq-bot/core";
import type { PluginLoadOptions } from "@qq-bot/core";
import type {
  Awaitable,
  BotAdapter,
  BotPlugin,
  ChatScope,
  IncomingMessage,
  Logger,
  MemberRole,
  OutgoingMessage,
  SentMessage
} from "@qq-bot/plugin-sdk";

export interface TestMessageOptions {
  authorId?: string;
  authorName?: string;
  role?: MemberRole;
  platform?: string;
  scope?: ChatScope;
  conversationId?: string;
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
  private onMessage:
    | ((message: IncomingMessage) => Awaitable<void>)
    | undefined;
  private nextMessageId = 1;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }

  public async stop(): Promise<void> {
    this.onMessage = undefined;
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
      id: `message-${this.nextMessageId++}`,
      platform: options.platform ?? this.name,
      scope: options.scope ?? "group",
      conversationId: options.conversationId ?? "conversation-1",
      author,
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
  }
}

export class PluginTestHost {
  private readonly adapter = new TestAdapter();
  private readonly kernel: BotKernel;
  private sentCursor = 0;

  public constructor(options: { commandPrefix?: string; logger?: Logger } = {}) {
    this.kernel = new BotKernel({
      adapter: this.adapter,
      logger: options.logger ?? new SilentLogger(),
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

  public getHealth() {
    return this.kernel.getHealth();
  }
}

export function createPluginTestHost(
  options: { commandPrefix?: string; logger?: Logger } = {}
): PluginTestHost {
  return new PluginTestHost(options);
}
