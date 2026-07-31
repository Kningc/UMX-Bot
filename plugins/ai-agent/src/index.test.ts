import type {
  Awaitable,
  BotAdapter,
  ChatScope,
  IncomingMessage,
  Logger,
  OutgoingMessage,
  SentMessage
} from "@qq-bot/plugin-sdk";
import { BotKernel } from "@qq-bot/core";
import { Response as NodeFetchResponse } from "node-fetch";
import { describe, expect, it, vi } from "vitest";
import {
  createAiAgentPlugin,
  evaluateExpression,
  toWebResponse
} from "./index.js";

class TestLogger implements Logger {
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
  private onMessage?: (message: IncomingMessage) => Awaitable<void>;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }
  public async stop(): Promise<void> {}
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
    scope: ChatScope,
    conversationId: string,
    authorId = "user-1"
  ): Promise<void> {
    await this.onMessage?.({
      id: `message-${this.sent.length}`,
      platform: "test",
      scope,
      conversationId,
      author: { id: authorId, role: "member" },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
  }
}

const config = {
  allowedGroupIds: ["allowed-group"],
  baseURL: "https://llm.example.test/v1",
  apiKey: "test-key",
  model: "test-model"
};

describe("ai-agent plugin", () => {
  it("normalizes node-fetch responses to WHATWG responses for AI SDK", async () => {
    const response = await toWebResponse(
      new NodeFetchResponse(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    expect(typeof response.body?.getReader).toBe("function");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("evaluates only bounded arithmetic expressions", () => {
    expect(evaluateExpression("2 + 3 * (4 - 1) ^ 2")).toBe(29);
    expect(evaluateExpression("2 ^ -2")).toBe(0.25);
    expect(() => evaluateExpression("1 / 0")).toThrow("不能除以零");
    expect(() => evaluateExpression("process.exit()")).toThrow();
  });

  it("never calls the model in private chat or an unconfigured group", async () => {
    const generate = vi.fn(async () => "should not be returned");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      { config }
    );
    await bot.start();

    await adapter.receive("/ai hello", "direct", "user-1");
    await adapter.receive("/ai hello", "group", "other-group");

    expect(adapter.sent.map((message) => message.content)).toEqual([
      "AI 助手仅在已启用的群聊中可用，私聊不可用。",
      "当前群未启用 AI 助手。"
    ]);
    expect(generate).not.toHaveBeenCalled();
    await bot.stop();
  });

  it("calls the model only for configured text-only group requests", async () => {
    const generate = vi.fn(async () => "  safe answer  ");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      { config }
    );
    await bot.start();

    await adapter.receive("/ai explain agents", "group", "allowed-group");

    expect(generate).toHaveBeenCalledWith(
      "explain agents",
      expect.objectContaining({ timeoutMs: 45_000 })
    );
    expect(adapter.sent[0]?.content).toBe("safe answer");
    await bot.stop();
  });

  it("validates the allowlist and HTTPS model endpoint", () => {
    const plugin = createAiAgentPlugin();
    expect(() =>
      plugin.configuration?.parse({ ...config, allowedGroupIds: [] })
    ).toThrow();
    expect(() =>
      plugin.configuration?.parse({ ...config, baseURL: "http://localhost/v1" })
    ).toThrow();
  });

  it("enforces the persistent daily request limit per group", async () => {
    const generate = vi.fn(async () => "answer");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      { config: { ...config, dailyRequestLimitPerGroup: 1 } }
    );
    await bot.start();

    await adapter.receive("/ai first", "group", "allowed-group", "user-1");
    await adapter.receive("/ai second", "group", "allowed-group", "user-2");

    expect(generate).toHaveBeenCalledTimes(1);
    expect(adapter.sent.at(-1)?.content).toBe(
      "当前群今天的 AI 调用额度已用完。"
    );
    await bot.stop();
  });

  it("allows unlimited daily requests when the limit is zero", async () => {
    const generate = vi.fn(async () => "answer");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      { config: { ...config, dailyRequestLimitPerGroup: 0 } }
    );
    await bot.start();

    await adapter.receive("/ai first", "group", "allowed-group", "user-1");
    await adapter.receive("/ai second", "group", "allowed-group", "user-2");

    expect(generate).toHaveBeenCalledTimes(2);
    await bot.stop();
  });
});
