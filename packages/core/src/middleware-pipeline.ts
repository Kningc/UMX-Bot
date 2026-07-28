import type {
  Dispose,
  IncomingMessage,
  MessageMiddleware,
  MessageMiddlewareContext,
  MessageSender,
  MiddlewareOptions,
  MiddlewareRegistry
} from "@qq-bot/plugin-sdk";

interface RegisteredMiddleware {
  plugin: string;
  middleware: MessageMiddleware;
  priority: number;
  order: number;
  active: boolean;
}

export class MiddlewareExecutionError extends Error {
  public constructor(
    public readonly plugin: string,
    options: { cause: unknown }
  ) {
    super(`middleware from plugin "${plugin}" failed`, options);
    this.name = "MiddlewareExecutionError";
  }
}

export class MiddlewarePipeline {
  private readonly entries: RegisteredMiddleware[] = [];
  private nextOrder = 0;

  public constructor(private readonly messages: MessageSender) {}

  public forPlugin(plugin: string): MiddlewareRegistry {
    return {
      use: (middleware, options) =>
        this.register(plugin, middleware, options)
    };
  }

  public async run(
    message: IncomingMessage,
    terminal: (context: MessageMiddlewareContext) => Promise<void>
  ): Promise<void> {
    const entries = this.entries
      .filter((entry) => entry.active)
      .sort(
        (left, right) =>
          right.priority - left.priority || left.order - right.order
      );
    const context: MessageMiddlewareContext = {
      message,
      state: new Map<string, unknown>(),
      handled: false,
      reply: (content) => this.messages.reply(message, content)
    };

    const dispatch = async (index: number): Promise<void> => {
      const entry = entries[index];
      if (!entry) {
        await terminal(context);
        return;
      }

      let nextCalled = false;
      try {
        await entry.middleware(context, async () => {
          if (nextCalled) {
            throw new Error(
              `middleware from plugin "${entry.plugin}" called next() more than once`
            );
          }
          nextCalled = true;
          await dispatch(index + 1);
        });
      } catch (error) {
        if (error instanceof MiddlewareExecutionError) {
          throw error;
        }
        throw new MiddlewareExecutionError(entry.plugin, { cause: error });
      }
    };

    await dispatch(0);
  }

  private register(
    plugin: string,
    middleware: MessageMiddleware,
    options: MiddlewareOptions = {}
  ): Dispose {
    const entry: RegisteredMiddleware = {
      plugin,
      middleware,
      priority: options.priority ?? 0,
      order: this.nextOrder++,
      active: true
    };
    this.entries.push(entry);

    return () => {
      entry.active = false;
      const index = this.entries.indexOf(entry);
      if (index >= 0) {
        this.entries.splice(index, 1);
      }
    };
  }
}
