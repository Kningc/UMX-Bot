import { EventEmitter } from "node:events";
import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  MemberRole,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";
import { BotKernel } from "@qq-bot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import minecraftStatusPlugin, {
  normalizeServerAddress,
  queryJavaServerStatus
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
  public rejectNextRichMessage = false;
  private onMessage?: (message: IncomingMessage) => Awaitable<void>;

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.onMessage = onMessage;
  }

  public async stop(): Promise<void> {}

  public async send(message: OutgoingMessage): Promise<void> {
    if (
      this.rejectNextRichMessage &&
      typeof message.content !== "string"
    ) {
      this.rejectNextRichMessage = false;
      throw new Error("simulated image upload failure");
    }
    this.sent.push(message);
  }

  public async receive(
    content: string,
    role: MemberRole = "member"
  ): Promise<void> {
    await this.onMessage?.({
      id: `message-${this.sent.length}`,
      platform: "test",
      scope: "group",
      conversationId: "group-1",
      author: { id: "user-1", role },
      content,
      attachments: [],
      mentions: [],
      timestamp: new Date()
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("minecraft-status plugin", () => {
  it("normalizes domains, IDNs and ports", () => {
    expect(normalizeServerAddress(" Play.Example.COM:25565 ")).toBe(
      "play.example.com:25565"
    );
    expect(normalizeServerAddress("例子.测试")).toBe(
      "xn--fsqu00a.xn--0zwm56d"
    );
    expect(normalizeServerAddress("[2001:db8::1]:19132")).toBe(
      "[2001:db8::1]:19132"
    );
    expect(() => normalizeServerAddress("https://example.com")).toThrow();
    expect(() => normalizeServerAddress("example.com:70000")).toThrow();
  });

  it("allows an admin to configure and query a Java server", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          online: true,
          version: "1.21.8",
          software: "Paper",
          motd: { clean: ["A friendly server"] },
          players: {
            online: 2,
            max: 20,
            list: [{ name: "Alex" }, { name: "Steve" }]
          },
          icon: `data:image/png;base64,${Buffer.from("png").toString("base64")}`
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(minecraftStatusPlugin);
    await bot.start();

    await adapter.receive("/mc set play.example.com java", "admin");
    await adapter.receive("/mc");

    expect(adapter.sent[0]?.content).toBe(
      "已将当前会话的 Minecraft 服务器设置为 play.example.com（Java）。"
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mcsrvstat.us/3/play.example.com",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "qq-bot-minecraft-status/0.1.1"
        })
      })
    );
    const reply = adapter.sent[1]?.content;
    expect(typeof reply).toBe("object");
    if (typeof reply !== "string" && reply) {
      expect(reply.text).toContain("🟢 Minecraft 服务器在线");
      expect(reply.text).toContain("玩家：2/20");
      expect(reply.text).toContain("Alex、Steve");
      expect(reply.media[0].source.type).toBe("data");
    }

    await bot.stop();
  });

  it("protects conversation configuration and supports Bedrock queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ online: false }), { status: 200 })
      )
    );
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(minecraftStatusPlugin);
    await bot.start();

    await adapter.receive("/mc set play.example.com", "member");
    await adapter.receive("/mc play.example.com:19132 bedrock");

    expect(adapter.sent[0]?.content).toBe(
      "只有管理员或群主可以修改服务器配置。"
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.mcsrvstat.us/bedrock/3/play.example.com%3A19132",
      expect.any(Object)
    );
    const reply = adapter.sent[1]?.content;
    expect(typeof reply).toBe("object");
    if (typeof reply !== "string" && reply) {
      expect(reply.text).toContain("🔴 Minecraft 服务器离线");
      expect(reply.media[0].source).toEqual({
        type: "url",
        url: "https://api.mcsrvstat.us/icon/play.example.com%3A19132"
      });
    }

    await bot.stop();
  });

  it("parses a direct Java status response without a real network socket", async () => {
    const encodeVarInt = (value: number): Buffer => {
      const bytes: number[] = [];
      let remaining = value;
      do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining > 0) byte |= 0x80;
        bytes.push(byte);
      } while (remaining > 0);
      return Buffer.from(bytes);
    };
    const json = Buffer.from(
      JSON.stringify({
        version: { name: "1.21.8", protocol: 772 },
        players: {
          online: 1,
          max: 10,
          sample: [{ name: "LocalPlayer", id: "player-id" }]
        },
        description: {
          text: "Direct ",
          extra: [{ text: "server" }]
        }
      }),
      "utf8"
    );
    const payload = Buffer.concat([
      Buffer.from([0]),
      encodeVarInt(json.byteLength),
      json
    ]);
    const response = Buffer.concat([
      encodeVarInt(payload.byteLength),
      payload
    ]);
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      setTimeout: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
      write: vi.fn(() => {
        queueMicrotask(() => emitter.emit("data", response));
        return true;
      })
    });
    const connect = vi.fn(() => {
      queueMicrotask(() => emitter.emit("connect"));
      return socket as never;
    });

    const status = await queryJavaServerStatus(
      "127.0.0.1:25565",
      undefined,
      connect
    );

    expect(status).toMatchObject({
      online: true,
      version: "1.21.8",
      motd: { clean: ["Direct server"] },
      players: {
        online: 1,
        max: 10,
        list: [{ name: "LocalPlayer", uuid: "player-id" }]
      }
    });
    expect(socket.write).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("falls back to text when the server icon cannot be sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            online: true,
            version: "1.21.8",
            players: { online: 0, max: 10 }
          }),
          { status: 200 }
        )
      )
    );
    const adapter = new TestAdapter();
    const bot = new BotKernel({ adapter, logger: new TestLogger() });
    await bot.load(minecraftStatusPlugin);
    await bot.start();

    await adapter.receive("/mc set play.example.com java", "admin");
    adapter.rejectNextRichMessage = true;
    await adapter.receive("/mc");

    expect(adapter.sent[1]?.content).toContain("🟢 Minecraft 服务器在线");
    expect(adapter.sent[1]?.content).toContain("已降级为文字状态");
    await bot.stop();
  });
});
