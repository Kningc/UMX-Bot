import process from "node:process";
import type { ChatScope, Logger } from "@qq-bot/plugin-sdk";
import { QqOfficialAdapter } from "./index.js";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

if (process.env.QQ_SMOKE_CONFIRM !== "send-and-recall") {
  throw new Error(
    "Set QQ_SMOKE_CONFIRM=send-and-recall to acknowledge that the smoke test sends and recalls real QQ messages"
  );
}
const appId = process.env.QQ_APP_ID;
const clientSecret = process.env.QQ_CLIENT_SECRET;
if (!appId || !clientSecret) {
  throw new Error("QQ_APP_ID and QQ_CLIENT_SECRET are required");
}

const requestedScopes = new Set(
  (process.env.QQ_SMOKE_SCOPES ?? "direct,group")
    .split(",")
    .map((value) => value.trim())
    .filter(
      (value): value is Extract<ChatScope, "direct" | "group"> =>
        value === "direct" || value === "group"
    )
);
if (requestedScopes.size === 0) {
  throw new Error("QQ_SMOKE_SCOPES must include direct and/or group");
}

const logger: Logger = {
  debug: () => undefined,
  info: (data, message) => console.info(message ?? "info", data),
  warn: (data, message) => console.warn(message ?? "warn", data),
  error: (data, message) => console.error(message ?? "error", data),
  child() {
    return this;
  }
};

const adapter = new QqOfficialAdapter({
  appId,
  clientSecret,
  logger,
  receiveAllGroupMessages: false,
  requestTimeoutMs: 15_000,
  gatewayReadyTimeoutMs: 20_000
});
const completed = new Set<"direct" | "group">();
let resolveCompletion: (() => void) | undefined;
const completion = new Promise<void>((resolve) => {
  resolveCompletion = resolve;
});

await adapter.start(async (message) => {
  if (
    (message.scope !== "direct" && message.scope !== "group") ||
    !requestedScopes.has(message.scope) ||
    completed.has(message.scope)
  ) {
    return;
  }
  const target = { type: "message" as const, messageId: message.id };
  if (message.scope === "direct") {
    await adapter.setTyping(message, 3, target);
  }
  const textReceipt = await adapter.send({
    scope: message.scope,
    conversationId: message.conversationId,
    delivery: { type: "passive", target },
    content: "QQ SDK 冒烟测试：文本发送成功。"
  });
  await adapter.send({
    scope: message.scope,
    conversationId: message.conversationId,
    delivery: { type: "passive", target },
    content: { markdown: "## QQ SDK 冒烟测试\nMarkdown 发送成功。" }
  });
  const imageUrl = process.env.QQ_SMOKE_IMAGE_URL;
  if (imageUrl) {
    await adapter.send({
      scope: message.scope,
      conversationId: message.conversationId,
      delivery: { type: "passive", target },
      content: {
        text: "小图片上传成功。",
        media: [{ type: "image", source: { type: "url", url: imageUrl } }]
      }
    });
  }
  await adapter.recall(textReceipt);
  completed.add(message.scope);
  console.info(`QQ smoke scope completed: ${message.scope}`);
  if ([...requestedScopes].every((scope) => completed.has(scope))) {
    resolveCompletion?.();
  }
});

console.info(
  `Gateway ready. Send a message to the bot for: ${[...requestedScopes].join(", ")}`
);
const timeoutMs = 5 * 60_000;
let timeout: NodeJS.Timeout | undefined;
try {
  await Promise.race([
    completion,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("QQ smoke test timed out waiting for messages")),
        timeoutMs
      );
    })
  ]);
} finally {
  if (timeout) {
    clearTimeout(timeout);
  }
  await adapter.stop();
}

console.info("QQ smoke test passed", adapter.getDiagnostics());
