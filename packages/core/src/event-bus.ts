import type {
  Awaitable,
  BotEvents,
  Dispose,
  EventSubscriptionOptions,
  EventSubscriber,
  Logger
} from "@qq-bot/plugin-sdk";

type AnyEventHandler = (payload: BotEvents[keyof BotEvents]) => Awaitable<void>;

interface Subscription {
  handler: AnyEventHandler;
  priority: number;
  once: boolean;
  order: number;
  active: boolean;
}

export class EventBus implements EventSubscriber {
  private readonly handlers = new Map<keyof BotEvents, Subscription[]>();
  private nextOrder = 0;

  public constructor(private readonly logger: Logger) {}

  public on<K extends keyof BotEvents>(
    event: K,
    handler: (payload: BotEvents[K]) => Awaitable<void>,
    options: EventSubscriptionOptions = {}
  ): Dispose {
    const handlers = this.handlers.get(event) ?? [];
    const subscription: Subscription = {
      handler: handler as AnyEventHandler,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      order: this.nextOrder++,
      active: true
    };
    handlers.push(subscription);
    this.handlers.set(event, handlers);

    return () => {
      subscription.active = false;
      const index = handlers.indexOf(subscription);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    };
  }

  public async emit<K extends keyof BotEvents>(
    event: K,
    payload: BotEvents[K]
  ): Promise<void> {
    const subscriptions = [...(this.handlers.get(event) ?? [])]
      .filter((subscription) => subscription.active)
      .sort(
        (left, right) =>
          right.priority - left.priority || left.order - right.order
      );

    const results = await Promise.allSettled(
      subscriptions.map((subscription) => {
        if (subscription.once) {
          subscription.active = false;
          const current = this.handlers.get(event);
          const index = current?.indexOf(subscription) ?? -1;
          if (current && index >= 0) {
            current.splice(index, 1);
          }
        }
        return Promise.resolve().then(() =>
          subscription.handler(payload as BotEvents[keyof BotEvents])
        );
      })
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
