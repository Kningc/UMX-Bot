import type {
  Dispose,
  OutboundHook,
  OutboundRegistry,
  OutgoingMessage,
  SentMessage
} from "@umx-bot/plugin-sdk";

interface Entry {
  plugin: string;
  hook: OutboundHook;
  priority: number;
  order: number;
  active: boolean;
}

export class OutboundHookError extends Error {
  public constructor(
    public readonly plugin: string,
    options: { cause: unknown }
  ) {
    super(`outbound hook from plugin "${plugin}" failed`, options);
    this.name = "OutboundHookError";
  }
}

/**
 * Onion pipeline around every message the bot sends through `MessageSender`.
 *
 * A hook may rewrite the message, send it in pieces (call `next` repeatedly),
 * or swallow it. Adapter-internal traffic (streams, recalls, the Outbox
 * replaying an uncertain send) deliberately bypasses it.
 */
export class OutboundPipeline {
  private readonly entries: Entry[] = [];
  private nextOrder = 0;

  public forPlugin(plugin: string): OutboundRegistry {
    return {
      use: (hook, options = {}) => this.register(plugin, hook, options.priority)
    };
  }

  public send(
    message: OutgoingMessage,
    terminal: (message: OutgoingMessage) => Promise<SentMessage>
  ): Promise<SentMessage> {
    const entries = this.entries
      .filter((entry) => entry.active)
      .sort(
        (left, right) =>
          right.priority - left.priority || left.order - right.order
      );
    const dispatch = async (
      index: number,
      current: OutgoingMessage
    ): Promise<SentMessage> => {
      const entry = entries[index];
      if (!entry) {
        return terminal(current);
      }
      try {
        return await entry.hook(current, (replacement) =>
          dispatch(index + 1, replacement ?? current)
        );
      } catch (error) {
        if (error instanceof OutboundHookError) {
          throw error;
        }
        throw new OutboundHookError(entry.plugin, { cause: error });
      }
    };
    return dispatch(0, message);
  }

  private register(plugin: string, hook: OutboundHook, priority = 0): Dispose {
    if (!Number.isSafeInteger(priority)) {
      throw new Error("outbound hook priority must be an integer");
    }
    const entry: Entry = {
      plugin,
      hook,
      priority,
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
