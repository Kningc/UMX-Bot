import type {
  Dispose,
  InteractionContext,
  InteractionEvent,
  InteractionRegistry,
  Logger,
  MessageContent,
  SentMessage
} from "@umx-bot/plugin-sdk";

type Handler = (context: InteractionContext) => void | Promise<void>;

interface Registration {
  plugin: string;
  action: string;
  handler: Handler;
}

/**
 * Routes `callback` button presses back to the plugin that built the button.
 *
 * Button data is `<plugin>:<action>[:<payload>]`. The plugin name makes the
 * route unambiguous without a global action registry, and `encode()` keeps
 * plugins from having to know the format.
 */
export class InteractionRouter {
  private readonly registrations: Registration[] = [];

  public constructor(
    private readonly send: (
      event: InteractionEvent,
      content: MessageContent
    ) => Promise<SentMessage>,
    private readonly logger: Logger
  ) {}

  public forPlugin(
    plugin: string,
    track: (dispose: Dispose) => Dispose
  ): InteractionRegistry {
    return {
      handle: (action, handler) => {
        if (action.length === 0 || action.includes(":")) {
          throw new Error(
            "interaction action cannot be empty or contain a colon"
          );
        }
        const registration: Registration = { plugin, action, handler };
        this.registrations.push(registration);
        return track(() => {
          const index = this.registrations.indexOf(registration);
          if (index >= 0) {
            this.registrations.splice(index, 1);
          }
        });
      },
      encode: (action, payload) =>
        payload === undefined
          ? `${plugin}:${action}`
          : `${plugin}:${action}:${payload}`
    };
  }

  /** Returns true when a registered handler took the press. */
  public async route(event: InteractionEvent): Promise<boolean> {
    const data = event.data;
    if (!data) {
      return false;
    }
    const first = data.indexOf(":");
    if (first <= 0) {
      return false;
    }
    const plugin = data.slice(0, first);
    const rest = data.slice(first + 1);
    const second = rest.indexOf(":");
    const action = second < 0 ? rest : rest.slice(0, second);
    const payload = second < 0 ? "" : rest.slice(second + 1);

    const matches = this.registrations.filter(
      (registration) =>
        registration.plugin === plugin && registration.action === action
    );
    for (const registration of matches) {
      try {
        await registration.handler({
          event,
          action,
          payload,
          reply: (content) => this.send(event, content)
        });
      } catch (error) {
        this.logger.error(
          { error, plugin, action },
          "interaction handler failed"
        );
      }
    }
    return matches.length > 0;
  }
}
