import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type {
  Awaitable,
  BotAdapter,
  IncomingMessage,
  Logger,
  OutgoingMessage
} from "@qq-bot/plugin-sdk";

export interface ConsoleAdapterOptions {
  logger: Logger;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class ConsoleAdapter implements BotAdapter {
  public readonly name = "console";
  private readonly logger: Logger;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readline: Interface | undefined;
  private running = false;

  public constructor(options: ConsoleAdapterOptions) {
    this.logger = options.logger;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  public async start(
    onMessage: (message: IncomingMessage) => Awaitable<void>
  ): Promise<void> {
    this.running = true;
    this.readline = createInterface({
      input: this.input,
      output: this.output,
      prompt: "> "
    });
    this.readline.once("close", () => {
      this.running = false;
    });

    this.output.write(
      "Console adapter 已启动。输入 /help 查看命令，Ctrl+C 退出。\n"
    );
    this.readline.prompt();
    this.readline.on("line", (line) => {
      const message: IncomingMessage = {
        id: randomUUID(),
        platform: "console",
        scope: "group",
        conversationId: "local",
        author: {
          id: "local-owner",
          name: "Local Owner",
          role: "owner"
        },
        content: line,
        attachments: [],
        mentions: [],
        timestamp: new Date(),
        raw: line
      };

      Promise.resolve(onMessage(message))
        .catch((error: unknown) => {
          this.logger.error({ error }, "console message failed");
        })
        .finally(() => {
          const currentReadline = this.readline;
          if (this.running && currentReadline) {
            currentReadline.prompt();
          }
        });
    });
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.readline?.close();
    this.readline = undefined;
  }

  public async send(message: OutgoingMessage): Promise<void> {
    if (typeof message.content === "string") {
      this.output.write(`机器人: ${message.content}\n`);
      return;
    }

    const fallbackText =
      message.content.markdown ?? message.content.text;
    if (fallbackText) {
      this.output.write(`机器人: ${fallbackText}\n`);
    }
    for (const media of message.content.media ?? []) {
      const source =
        media.source.type === "url"
          ? media.source.url
          : `<${media.source.data.byteLength} bytes>`;
      this.output.write(
        `机器人 [${media.type}${media.filename ? ` ${media.filename}` : ""}]: ${source}\n`
      );
    }
    for (const row of message.content.keyboard?.rows ?? []) {
      this.output.write(
        `机器人 [导航]: ${row
          .map((button) => `${button.label}(${button.command})`)
          .join(" | ")}\n`
      );
    }
  }
}
