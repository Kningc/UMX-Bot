import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  OutgoingMessage,
  SentMessage
} from "@qq-bot/plugin-sdk";
import { describe, expect, it } from "vitest";
import { adapterConformanceChecks } from "./conformance.js";

class WellBehavedAdapter implements BotAdapter {
  // Widened to `string` so the deliberately broken subclasses below can
  // override it the way a real misbehaving adapter would.
  public readonly name: string = "well-behaved";
  protected started = false;
  private counter = 0;

  public async start(
    _onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.started = false;
  }

  public async send(message: OutgoingMessage): Promise<SentMessage> {
    this.counter += 1;
    return {
      platform: this.name,
      scope: message.scope,
      conversationId: message.conversationId,
      id: `sent-${this.counter}`,
      timestamp: new Date()
    };
  }

  public getDiagnostics(): Record<string, unknown> {
    return { started: this.started, sent: this.counter };
  }
}

async function runAll(createAdapter: () => BotAdapter): Promise<string[]> {
  const failures: string[] = [];
  for (const check of adapterConformanceChecks({ createAdapter })) {
    try {
      await check.run();
    } catch (error) {
      failures.push(
        `${check.name}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  return failures;
}

describe("adapterConformanceChecks", () => {
  it("passes a well-behaved adapter", async () => {
    await expect(runAll(() => new WellBehavedAdapter())).resolves.toEqual([]);
  });

  it("runs every check through a fresh adapter", async () => {
    const created: BotAdapter[] = [];
    const checks = adapterConformanceChecks({
      createAdapter: () => {
        const adapter = new WellBehavedAdapter();
        created.push(adapter);
        return adapter;
      }
    });
    for (const check of checks) {
      await check.run();
    }
    expect(created).toHaveLength(checks.length);
    expect(new Set(created).size).toBe(checks.length);
  });

  // Each case below is a real way an adapter can be wrong. If the suite ever
  // stops catching one of them, it has become decorative.
  it("rejects a name that is not lowercase", async () => {
    class Shouty extends WellBehavedAdapter {
      public override readonly name = "Shouty";
    }
    const failures = await runAll(() => new Shouty());
    expect(failures.join("\n")).toMatch(/must be lowercase/u);
  });

  it("rejects an empty name", async () => {
    class Nameless extends WellBehavedAdapter {
      public override readonly name = "";
    }
    const failures = await runAll(() => new Nameless());
    expect(failures.join("\n")).toMatch(/non-empty string/u);
  });

  it("rejects a stop() that throws before start()", async () => {
    class Fragile extends WellBehavedAdapter {
      public override async stop(): Promise<void> {
        if (!this.started) {
          throw new Error("not started");
        }
        this.started = false;
      }
    }
    const failures = await runAll(() => new Fragile());
    expect(failures.join("\n")).toMatch(/not started/u);
  });

  it("rejects a start() that cannot be repeated", async () => {
    class SingleStart extends WellBehavedAdapter {
      private everStarted = false;
      public override async start(
        onMessage: (message: IncomingMessage) => Awaitable<void>
      ): Promise<void> {
        if (this.everStarted) {
          throw new Error("already started");
        }
        this.everStarted = true;
        await super.start(onMessage);
      }
    }
    const failures = await runAll(() => new SingleStart());
    expect(failures.join("\n")).toMatch(/already started/u);
  });

  it("rejects a receipt without a message id", async () => {
    class NoReceiptId extends WellBehavedAdapter {
      public override async send(
        message: OutgoingMessage
      ): Promise<SentMessage> {
        return { ...(await super.send(message)), id: "" };
      }
    }
    const failures = await runAll(() => new NoReceiptId());
    expect(failures.join("\n")).toMatch(/receipt\.id/u);
  });

  it("rejects a receipt that does not echo the conversation", async () => {
    class WrongConversation extends WellBehavedAdapter {
      public override async send(
        message: OutgoingMessage
      ): Promise<SentMessage> {
        return {
          ...(await super.send(message)),
          conversationId: "somewhere-else"
        };
      }
    }
    const failures = await runAll(() => new WrongConversation());
    expect(failures.join("\n")).toMatch(/receipt\.conversationId/u);
  });

  it("rejects a receipt timestamp that is not a Date", async () => {
    class StringTimestamp extends WellBehavedAdapter {
      public override async send(
        message: OutgoingMessage
      ): Promise<SentMessage> {
        return {
          ...(await super.send(message)),
          timestamp: "2026-11-21" as unknown as Date
        };
      }
    }
    const failures = await runAll(() => new StringTimestamp());
    expect(failures.join("\n")).toMatch(/receipt\.timestamp/u);
  });

  it("rejects diagnostics that cannot be serialized for the health snapshot", async () => {
    class CyclicDiagnostics extends WellBehavedAdapter {
      public override getDiagnostics(): Record<string, unknown> {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return cyclic;
      }
    }
    const failures = await runAll(() => new CyclicDiagnostics());
    expect(failures.join("\n")).toMatch(/circular|Converting circular/u);
  });

  it("rejects an adapter that requires an event handler", async () => {
    class NeedsOnEvent extends WellBehavedAdapter {
      public override async start(
        onMessage: (message: IncomingMessage) => Awaitable<void>,
        onEvent?: unknown
      ): Promise<void> {
        if (!onEvent) {
          throw new Error("onEvent is required");
        }
        await super.start(onMessage);
      }
    }
    const failures = await runAll(() => new NeedsOnEvent());
    expect(failures.join("\n")).toMatch(/onEvent is required/u);
  });

  it("can skip the send checks for an adapter that cannot send in tests", () => {
    const withSend = adapterConformanceChecks({
      createAdapter: () => new WellBehavedAdapter()
    });
    const withoutSend = adapterConformanceChecks({
      createAdapter: () => new WellBehavedAdapter(),
      skipSend: true
    });
    expect(withoutSend.length).toBeLessThan(withSend.length);
    expect(withoutSend.some((check) => check.name.includes("send()"))).toBe(
      false
    );
  });
});
