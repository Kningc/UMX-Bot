import type {
  Awaitable,
  BotEvents,
  Dispose,
  EventSubscriber,
  Logger
} from "@qq-bot/plugin-sdk";

type EventHandler<K extends keyof BotEvents> = (
  payload: BotEvents[K]
) => Awaitable<void>;

export class EventBus implements EventSubscriber {
  private readonly handlers = new Map<keyof BotEvents, Set<EventHandler<never>>>();

  public constructor(private readonly logger: Logger) {}

  public on<K extends keyof BotEvents>(
    event: K,
    handler: EventHandler<K>
  ): Dispose {
    const handlers =
      this.handlers.get(event) ?? new Set<EventHandler<never>>();
    handlers.add(handler as EventHandler<never>);
    this.handlers.set(event, handlers);

    return () => {
      handlers.delete(handler as EventHandler<never>);
    };
  }

  public async emit<K extends keyof BotEvents>(
    event: K,
    payload: BotEvents[K]
  ): Promise<void> {
    const handlers = [...(this.handlers.get(event) ?? [])];

    const results = await Promise.allSettled(
      handlers.map((handler) =>
        Promise.resolve().then(() => handler(payload as never))
      )
    );

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(
          { event, error: result.reason },
          "event handler failed"
        );
      }
    }
  }
}
