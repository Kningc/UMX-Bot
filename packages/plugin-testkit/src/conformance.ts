import type {
  Awaitable,
  BotAdapter,
  BotEvents,
  ChatScope,
  IncomingMessage,
  SentMessage
} from "@umx-bot/plugin-sdk";

export interface AdapterConformanceOptions {
  /**
   * Builds a fresh adapter. Called once per check, so a check can never be
   * affected by state another check left behind.
   */
  createAdapter: () => Awaitable<BotAdapter>;
  /**
   * A conversation the adapter accepts. Defaults to a group conversation,
   * which every adapter in this project supports.
   */
  conversation?: { scope: ChatScope; conversationId: string };
  /** Skips the `send()` checks for an adapter that cannot send in tests. */
  skipSend?: boolean;
}

export interface AdapterConformanceCheck {
  name: string;
  run: () => Promise<void>;
}

/**
 * The `BotAdapter` contract, as executable checks.
 *
 * The framework claims to be platform-neutral, but that claim is only worth
 * something if every adapter is held to the same behaviour. These checks cover
 * the invariants the kernel and the application rely on, so a new adapter can
 * be validated before it is wired into anything.
 *
 * Framework-agnostic on purpose: each check throws on failure, so it can be
 * driven from `it()`, `test()` or a plain loop.
 */
export function adapterConformanceChecks(
  options: AdapterConformanceOptions
): AdapterConformanceCheck[] {
  const conversation = options.conversation ?? {
    scope: "group" as ChatScope,
    conversationId: "conformance-conversation"
  };
  const create = async (): Promise<BotAdapter> => options.createAdapter();
  const noopHandlers = (): [
    (message: IncomingMessage) => Awaitable<void>,
    <K extends Exclude<keyof BotEvents, "message.created">>(
      event: K,
      payload: BotEvents[K]
    ) => Awaitable<void>
  ] => [() => undefined, () => undefined];

  const checks: AdapterConformanceCheck[] = [
    {
      name: "exposes a stable lowercase name",
      run: async () => {
        const adapter = await create();
        assert(
          typeof adapter.name === "string" && adapter.name.length > 0,
          "adapter.name must be a non-empty string"
        );
        assert(
          adapter.name === adapter.name.toLowerCase(),
          `adapter.name must be lowercase, got "${adapter.name}"`
        );
        assert(
          !/\s/u.test(adapter.name),
          `adapter.name must not contain whitespace, got "${adapter.name}"`
        );
        // The kernel reads `name` on every message, so it must not change.
        const first = adapter.name;
        await adapter.stop();
        assert(
          adapter.name === first,
          "adapter.name must not change over the lifecycle"
        );
      }
    },
    {
      name: "tolerates stop() before start()",
      run: async () => {
        const adapter = await create();
        // The kernel calls stop() during a failed startup rollback, possibly
        // before the adapter ever started.
        await adapter.stop();
      }
    },
    {
      name: "tolerates a repeated stop()",
      run: async () => {
        const adapter = await create();
        const [onMessage, onEvent] = noopHandlers();
        await adapter.start(onMessage, onEvent);
        await adapter.stop();
        await adapter.stop();
      }
    },
    {
      name: "treats a repeated start() as idempotent",
      run: async () => {
        const adapter = await create();
        const [onMessage, onEvent] = noopHandlers();
        await adapter.start(onMessage, onEvent);
        await adapter.start(onMessage, onEvent);
        await adapter.stop();
      }
    },
    {
      name: "can be restarted after a stop()",
      run: async () => {
        const adapter = await create();
        const [onMessage, onEvent] = noopHandlers();
        await adapter.start(onMessage, onEvent);
        await adapter.stop();
        await adapter.start(onMessage, onEvent);
        await adapter.stop();
      }
    },
    {
      name: "starts without an event handler",
      run: async () => {
        const adapter = await create();
        // `onEvent` is optional in the contract; an adapter must not assume it.
        await adapter.start(() => undefined);
        await adapter.stop();
      }
    },
    {
      name: "reports JSON-serializable diagnostics",
      run: async () => {
        const adapter = await create();
        if (!adapter.getDiagnostics) {
          return;
        }
        const [onMessage, onEvent] = noopHandlers();
        await adapter.start(onMessage, onEvent);
        try {
          const diagnostics = adapter.getDiagnostics();
          assert(
            diagnostics !== null && typeof diagnostics === "object",
            "getDiagnostics() must return an object"
          );
          // The application writes diagnostics into its health snapshot, so a
          // value that cannot be serialized breaks health checks in production.
          const serialized = JSON.stringify(diagnostics);
          assert(
            typeof serialized === "string",
            "getDiagnostics() must be JSON-serializable"
          );
          JSON.parse(serialized);
        } finally {
          await adapter.stop();
        }
      }
    },
    {
      name: "keeps diagnostics callable before start()",
      run: async () => {
        const adapter = await create();
        if (!adapter.getDiagnostics) {
          return;
        }
        // The health snapshot is written before the kernel starts.
        JSON.stringify(adapter.getDiagnostics());
        await adapter.stop();
      }
    }
  ];

  if (!options.skipSend) {
    checks.push(
      {
        name: "returns a usable receipt from send()",
        run: async () => {
          const adapter = await create();
          const [onMessage, onEvent] = noopHandlers();
          await adapter.start(onMessage, onEvent);
          try {
            const receipt = await adapter.send({
              scope: conversation.scope,
              conversationId: conversation.conversationId,
              content: "conformance",
              delivery: { type: "active", idempotencyKey: "conformance-1" }
            });
            assertReceipt(receipt, adapter.name, conversation);
          } finally {
            await adapter.stop();
          }
        }
      },
      {
        name: "echoes the conversation of a passive reply",
        run: async () => {
          const adapter = await create();
          const [onMessage, onEvent] = noopHandlers();
          await adapter.start(onMessage, onEvent);
          try {
            const receipt = await adapter.send({
              scope: conversation.scope,
              conversationId: conversation.conversationId,
              content: "conformance",
              delivery: {
                type: "passive",
                target: { type: "message", messageId: "incoming-1" }
              }
            });
            assertReceipt(receipt, adapter.name, conversation);
          } finally {
            await adapter.stop();
          }
        }
      }
    );
  }

  return checks;
}

function assertReceipt(
  receipt: SentMessage,
  platform: string,
  conversation: { scope: ChatScope; conversationId: string }
): void {
  assert(
    receipt !== null && typeof receipt === "object",
    "send() must resolve with a SentMessage"
  );
  assert(
    receipt.platform === platform,
    `receipt.platform must be "${platform}", got "${receipt.platform}"`
  );
  assert(
    receipt.scope === conversation.scope,
    `receipt.scope must echo the request, got "${receipt.scope}"`
  );
  assert(
    receipt.conversationId === conversation.conversationId,
    "receipt.conversationId must echo the request"
  );
  assert(
    typeof receipt.id === "string" && receipt.id.length > 0,
    "receipt.id must be a non-empty string so the message can be recalled"
  );
  assert(
    receipt.timestamp instanceof Date &&
      Number.isFinite(receipt.timestamp.getTime()),
    "receipt.timestamp must be a valid Date"
  );
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`adapter conformance: ${message}`);
  }
}
