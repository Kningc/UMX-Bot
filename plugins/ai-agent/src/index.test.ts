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
  classifyAiAgentFailure,
  createAiAgentPlugin,
  evaluateExpression,
  extractMentionPrompt,
  formatAgentReply,
  markdownToPlainText,
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
  public readonly sendFailures: unknown[] = [];
  private onMessage?: (message: IncomingMessage) => Awaitable<void>;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }
  public async stop(): Promise<void> {}
  public async send(message: OutgoingMessage): Promise<SentMessage> {
    if (this.sendFailures.length > 0) {
      throw this.sendFailures.shift();
    }
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
    authorId = "user-1",
    botMentioned = false
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
      ...(botMentioned ? { botMentioned: true } : {}),
      timestamp: new Date()
    });
  }
}

const config = {
  allowedGroupIds: ["allowed-group"],
  baseURL: "https://llm.example.test/v1",
  apiKey: "test-key",
  model: "test-model",
  spontaneousReplyProbability: 0
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

  it("sends model output as QQ markdown with a readable text fallback", () => {
    const markdown = "# 标题\n\n**重点**：[来源](https://example.com)\n\n```ts\nconst ok = true;\n```";
    expect(markdownToPlainText(markdown)).toBe(
      "标题\n\n重点：来源 (https://example.com)\n\nconst ok = true;"
    );
    expect(formatAgentReply(markdown)).toEqual({
      text: "标题\n\n重点：来源 (https://example.com)\n\nconst ok = true;",
      markdown
    });
  });

  it("extracts text following common QQ bot mention formats", () => {
    expect(extractMentionPrompt("<@!bot-openid_123> \u200b 你好")).toBe("你好");
    expect(extractMentionPrompt("@UMX_bot 你好")).toBe("你好");
    expect(extractMentionPrompt("你好")).toBe("你好");
    expect(extractMentionPrompt("@UMX_bot")).toBe("");
  });

  it("classifies common model, network, search and QQ failures", () => {
    expect(
      classifyAiAgentFailure(
        { name: "AbortError", type: "aborted" },
        { timeoutMs: 240_000, stage: "generation" }
      )
    ).toMatchObject({ category: "timeout" });
    expect(
      classifyAiAgentFailure(
        { name: "AI_APICallError", statusCode: 429 },
        { timeoutMs: 240_000, stage: "generation" }
      )
    ).toMatchObject({ category: "model_rate_limit" });
    expect(
      classifyAiAgentFailure(
        { message: "SOCKS connection reset" },
        { timeoutMs: 240_000, stage: "generation" }
      )
    ).toMatchObject({ category: "network" });
    expect(
      classifyAiAgentFailure(
        { message: "Tavily search request failed" },
        { timeoutMs: 240_000, stage: "generation" }
      )
    ).toMatchObject({ category: "web_search" });
    expect(
      classifyAiAgentFailure(
        { name: "QqApiError", kind: "content", errCode: 40034006 },
        { timeoutMs: 240_000, stage: "delivery" }
      )
    ).toMatchObject({ category: "qq_content" });
  });

  it("returns a classified timeout instead of the generic command failure", async () => {
    const generate = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), {
        name: "AbortError",
        type: "aborted"
      });
    });
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({ createResponder: () => ({ generate }) }),
      { config: { ...config, timeoutMs: 240_000 } }
    );
    await bot.start();

    await adapter.receive("/ai slow request", "group", "allowed-group");

    expect(adapter.sent.at(-1)?.content).toContain("超过 240 秒");
    expect(adapter.sent.at(-1)?.content).not.toContain("命令执行失败");
    await bot.stop();
  });

  it("retries QQ content rejection with a safe classified message", async () => {
    const generate = vi.fn(async () => "answer rejected by QQ");
    const adapter = new TestAdapter();
    adapter.sendFailures.push({
      name: "QqApiError",
      kind: "content",
      errCode: 40034006,
      endpoint: "POST /v2/groups/group/messages"
    });
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({ createResponder: () => ({ generate }) }),
      { config }
    );
    await bot.start();

    await adapter.receive("/ai sensitive request", "group", "allowed-group");

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.content).toContain("被 QQ 内容审核拦截");
    expect(adapter.sent[0]?.content).not.toContain("命令执行失败");
    await bot.stop();
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
      expect.objectContaining({ timeoutMs: 90_000 })
    );
    expect(adapter.sent[0]?.content).toEqual({
      text: "safe answer",
      markdown: "safe answer"
    });
    await bot.stop();
  });

  it("accepts mention prompts without intercepting empty mentions or mentioned commands", async () => {
    const generate = vi.fn(async (_prompt: string) => "mention answer");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      { config }
    );
    await bot.start();

    await adapter.receive("@UMX_bot 你好", "group", "allowed-group", "user-1", true);
    await adapter.receive("@UMX_bot", "group", "allowed-group", "user-1", true);
    await adapter.receive(
      "@UMX_bot /ai 兼容旧命令",
      "group",
      "allowed-group",
      "user-1",
      true
    );
    await adapter.receive("没有提及机器人", "group", "allowed-group");

    expect(generate.mock.calls.map(([prompt]) => prompt)).toEqual([
      "你好",
      "兼容旧命令"
    ]);
    expect(adapter.sent).toHaveLength(2);
    await bot.stop();
  });

  it("occasionally replies in plain text using the previous 20 messages", async () => {
    const randomValues = [...Array.from({ length: 21 }, () => 1), 0];
    const generate = vi.fn(async (_prompt: string) => "  哈哈\n确实  ");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        random: () => randomValues.shift() ?? 1,
        createSpontaneousResponder: (parsedConfig) => {
          expect(parsedConfig.spontaneousModel).toBe(
            "deepseek-v4-flash-ascend1"
          );
          return { generate };
        }
      }),
      {
        config: { ...config, spontaneousReplyProbability: 0.05 }
      }
    );
    await bot.start();

    for (let index = 1; index <= 21; index += 1) {
      await adapter.receive(`消息 ${index}`, "group", "allowed-group");
    }
    await adapter.receive("目标消息", "group", "allowed-group");

    expect(generate).toHaveBeenCalledOnce();
    const prompt = generate.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("1. 群友：消息 2");
    expect(prompt).toContain("20. 群友：消息 21");
    expect(prompt).not.toContain("群友：消息 1\n");
    expect(prompt).toContain("目标消息：\n群友：目标消息");
    expect(generate).toHaveBeenCalledWith(
      prompt,
      expect.objectContaining({ timeoutMs: 30_000 })
    );
    expect(adapter.sent.at(-1)?.content).toBe("哈哈 确实");
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
    expect(plugin.configuration?.parse(config)).toMatchObject({
      reasoningEffort: "medium",
      spontaneousReplyProbability: 0,
      spontaneousModel: "deepseek-v4-flash-ascend1"
    });
    expect(
      plugin.configuration?.parse({
        allowedGroupIds: ["allowed-group"],
        baseURL: "https://llm.example.test/v1",
        apiKey: "test-key",
        model: "test-model"
      })
    ).toMatchObject({ spontaneousReplyProbability: 0.05 });
    expect(() =>
      plugin.configuration?.parse({ ...config, reasoningEffort: "extreme" })
    ).toThrow();
    expect(
      plugin.configuration?.parse({
        ...config,
        webSearchApiKey: "search-key",
        webSearchMaxResults: 5
      })
    ).toMatchObject({
      webSearchApiKey: "search-key",
      webSearchMaxResults: 5
    });
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

  it("allows immediate repeated requests when cooldown is zero", async () => {
    const generate = vi.fn(async () => "answer");
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(
      createAiAgentPlugin({
        createResponder: () => ({ generate })
      }),
      {
        config: {
          ...config,
          cooldownMs: 0,
          dailyRequestLimitPerGroup: 0
        }
      }
    );
    await bot.start();

    await adapter.receive("/ai first", "group", "allowed-group", "same-user");
    await adapter.receive("/ai second", "group", "allowed-group", "same-user");

    expect(generate).toHaveBeenCalledTimes(2);
    await bot.stop();
  });
});
