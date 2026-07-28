import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import {
  definePlugin,
  type CommandContext,
  type MemberRole,
  type MessageContent,
  type OutgoingMedia
} from "@qq-bot/plugin-sdk";

const API_BASE_URL = "https://api.mcsrvstat.us";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_PLAYER_NAMES = 20;
const MAX_EXTRA_NAMES = 8;

type Edition = "java" | "bedrock";

interface MinecraftSettings {
  address: string;
  edition: Edition;
}

interface ApiText {
  raw?: string[];
  clean?: string[];
}

interface ApiNamedItem {
  name?: string;
  version?: string;
}

interface ApiStatus {
  online: boolean;
  ip?: string;
  port?: number;
  hostname?: string;
  version?: string;
  protocol?: {
    name?: string;
    version?: number;
  };
  icon?: string;
  software?: string;
  map?: {
    clean?: string;
    raw?: string;
  };
  gamemode?: string;
  motd?: ApiText;
  players?: {
    online?: number;
    max?: number;
    list?: ApiNamedItem[];
  };
  plugins?: ApiNamedItem[];
  mods?: ApiNamedItem[];
}

class StatusQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StatusQueryError";
  }
}

function conversationScope(command: CommandContext) {
  return {
    level: "conversation" as const,
    platform: command.message.platform,
    scope: command.message.scope,
    conversationId: command.message.conversationId
  };
}

function canConfigure(role: MemberRole): boolean {
  return role === "admin" || role === "owner";
}

function parseEdition(value: string | undefined): Edition | undefined {
  switch (value?.toLowerCase()) {
    case "java":
    case "j":
      return "java";
    case "bedrock":
    case "be":
    case "b":
    case "基岩":
    case "基岩版":
      return "bedrock";
    default:
      return undefined;
  }
}

function editionLabel(edition: Edition): string {
  return edition === "java" ? "Java" : "Bedrock";
}

export function normalizeServerAddress(value: string): string {
  const input = value.trim();
  if (
    input.length === 0 ||
    input.length > 255 ||
    /[\s/?#@\\]/u.test(input) ||
    input.includes("://")
  ) {
    throw new Error("服务器地址格式无效");
  }

  let host: string;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(input);
  if (bracketed) {
    host = bracketed[1] ?? "";
    portText = bracketed[2];
    if (isIP(host) !== 6) {
      throw new Error("IPv6 地址格式无效");
    }
    host = `[${host.toLowerCase()}]`;
  } else if (isIP(input) === 6) {
    host = input.toLowerCase();
  } else {
    const separator = input.lastIndexOf(":");
    if (separator >= 0) {
      if (input.indexOf(":") !== separator) {
        throw new Error("带端口的 IPv6 地址需要使用 [地址]:端口");
      }
      host = input.slice(0, separator);
      portText = input.slice(separator + 1);
    } else {
      host = input;
    }

    const ipVersion = isIP(host);
    if (ipVersion === 0) {
      const asciiHost = domainToASCII(host).toLowerCase();
      if (
        asciiHost.length === 0 ||
        asciiHost.length > 253 ||
        !asciiHost.split(".").every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
        )
      ) {
        throw new Error("服务器域名格式无效");
      }
      host = asciiHost;
    } else {
      host = host.toLowerCase();
    }
  }

  if (portText !== undefined) {
    if (!/^\d{1,5}$/u.test(portText)) {
      throw new Error("端口必须是 1 到 65535 的整数");
    }
    const port = Number(portText);
    if (port < 1 || port > 65_535) {
      throw new Error("端口必须是 1 到 65535 的整数");
    }
    return `${host}:${port}`;
  }
  return host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiStatus(value: unknown): ApiStatus {
  if (!isRecord(value) || typeof value.online !== "boolean") {
    throw new StatusQueryError("查询服务返回了无法识别的数据");
  }
  return value as unknown as ApiStatus;
}

export async function queryServerStatus(
  address: string,
  edition: Edition,
  signal?: AbortSignal
): Promise<ApiStatus> {
  const route = edition === "bedrock" ? "bedrock/3" : "3";
  const url = `${API_BASE_URL}/${route}/${encodeURIComponent(address)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "qq-bot-minecraft-status/0.1.0"
      },
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new StatusQueryError("查询超时，请稍后再试");
    }
    throw new StatusQueryError("无法连接 Minecraft 状态查询服务");
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new StatusQueryError("查询过于频繁，请稍后再试");
    }
    throw new StatusQueryError(`状态查询服务暂时不可用（${response.status}）`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new StatusQueryError("查询服务返回的数据过大");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new StatusQueryError("查询服务返回的数据过大");
  }
  try {
    return parseApiStatus(JSON.parse(body) as unknown);
  } catch (error) {
    if (error instanceof StatusQueryError) {
      throw error;
    }
    throw new StatusQueryError("查询服务返回了无效的 JSON");
  }
}

function cleanLine(value: string): string {
  return value
    .replace(/§[0-9a-fk-or]/giu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
}

function safeLines(values: unknown, limit: number): string[] {
  return (Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === "string")
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, limit);
}

function safeName(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = cleanLine(value).slice(0, 80);
  return cleaned.length > 0 ? cleaned : undefined;
}

function formatNamedItems(
  label: string,
  items: unknown
): string | undefined {
  const names = (Array.isArray(items) ? items : [])
    .filter((item): item is ApiNamedItem => isRecord(item))
    .map((item) => safeName(item?.name))
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) {
    return undefined;
  }
  const shown = names.slice(0, MAX_EXTRA_NAMES);
  const remaining = names.length - shown.length;
  return `${label}：${shown.join("、")}${remaining > 0 ? ` 等 ${names.length} 个` : ""}`;
}

function formatStatus(
  status: ApiStatus,
  address: string,
  edition: Edition
): string {
  if (!status.online) {
    return [
      "🔴 Minecraft 服务器离线",
      `地址：${address}`,
      `版本类型：${editionLabel(edition)}`,
      "服务器可能正在维护，或未开放状态查询。"
    ].join("\n");
  }

  const lines = [
    "🟢 Minecraft 服务器在线",
    `地址：${address}`,
    `版本类型：${editionLabel(edition)}`
  ];
  const version = safeName(status.version) ?? safeName(status.protocol?.name);
  if (version) {
    lines.push(`游戏版本：${version}`);
  }
  const software = safeName(status.software);
  if (software) {
    lines.push(`服务端：${software}`);
  }
  const gamemode = safeName(status.gamemode);
  if (gamemode) {
    lines.push(`游戏模式：${gamemode}`);
  }
  const map = safeName(status.map?.clean) ?? safeName(status.map?.raw);
  if (map) {
    lines.push(`地图：${map}`);
  }

  const online = status.players?.online;
  const max = status.players?.max;
  if (typeof online === "number" && typeof max === "number") {
    lines.push(`玩家：${online}/${max}`);
  } else if (typeof online === "number") {
    lines.push(`在线玩家：${online}`);
  }

  const motd = safeLines(status.motd?.clean ?? status.motd?.raw, 4);
  if (motd.length > 0) {
    lines.push(`MOTD：\n${motd.join("\n")}`);
  }

  const playerNames = (
    Array.isArray(status.players?.list) ? status.players.list : []
  )
    .map((player) => safeName(player?.name))
    .filter((name): name is string => Boolean(name));
  if (playerNames.length > 0) {
    const shown = playerNames.slice(0, MAX_PLAYER_NAMES);
    const remaining = playerNames.length - shown.length;
    lines.push(
      `玩家列表（服务器公开样本）：${shown.join("、")}${
        remaining > 0 ? ` 等 ${playerNames.length} 人` : ""
      }`
    );
  } else if (typeof online === "number" && online > 0) {
    lines.push("玩家列表：服务器未公开");
  }

  const plugins = formatNamedItems("插件", status.plugins);
  if (plugins) {
    lines.push(plugins);
  }
  const mods = formatNamedItems("模组", status.mods);
  if (mods) {
    lines.push(mods);
  }
  return lines.join("\n");
}

function iconMedia(
  status: ApiStatus,
  address: string
): OutgoingMedia {
  const match =
    typeof status.icon === "string"
      ? /^data:image\/png;base64,([a-z0-9+/=\s]+)$/iu.exec(status.icon)
      : null;
  if (match?.[1]) {
    const data = Buffer.from(match[1], "base64");
    if (data.byteLength > 0 && data.byteLength <= MAX_ICON_BYTES) {
      return {
        type: "image",
        source: { type: "data", data },
        filename: "minecraft-server-icon.png",
        contentType: "image/png"
      };
    }
  }
  return {
    type: "image",
    source: {
      type: "url",
      url: `${API_BASE_URL}/icon/${encodeURIComponent(address)}`
    },
    filename: "minecraft-server-icon.png",
    contentType: "image/png"
  };
}

function statusMessage(
  status: ApiStatus,
  address: string,
  edition: Edition
): MessageContent {
  return {
    text: formatStatus(status, address, edition),
    media: [iconMedia(status, address)]
  };
}

const helpText = [
  "Minecraft 服务器状态命令：",
  "/mc - 查询当前会话已配置的服务器",
  "/mc <地址> [java|bedrock] - 临时查询",
  "/mc set <地址> [java|bedrock] - 配置当前会话（管理员）",
  "/mc config - 查看当前配置",
  "/mc reset - 清除当前会话配置（管理员）"
].join("\n");

export default definePlugin({
  name: "minecraft-status",
  version: "0.1.0",
  description: "查询 Minecraft Java/Bedrock 服务器状态",
  setup(context) {
    const settings = context.settings.define<MinecraftSettings>({
      key: "server",
      version: 1,
      defaults: {
        address: "",
        edition: "java"
      },
      schema: {
        parse(value) {
          if (
            !isRecord(value) ||
            typeof value.address !== "string" ||
            (value.edition !== "java" && value.edition !== "bedrock")
          ) {
            throw new Error("Minecraft 服务器配置格式错误");
          }
          return {
            address: value.address,
            edition: value.edition
          };
        }
      }
    });

    context.commands.register({
      name: "mc",
      aliases: ["mc状态", "服务器"],
      description: "查询或配置 Minecraft 服务器状态",
      usage: "/mc [地址] [java|bedrock]",
      async execute(command) {
        const [first, second, third] = command.args;
        const action = first?.toLowerCase();

        if (action === "help" || action === "帮助") {
          await command.reply(helpText);
          return;
        }

        if (action === "config" || action === "配置") {
          const current = await settings.get(command.message);
          await command.reply(
            current.address
              ? `当前 Minecraft 服务器：${current.address}（${editionLabel(current.edition)}）`
              : `当前会话尚未配置 Minecraft 服务器。\n${helpText}`
          );
          return;
        }

        if (action === "set" || action === "设置") {
          if (!canConfigure(command.message.author.role)) {
            await command.reply("只有管理员或群主可以修改服务器配置。");
            return;
          }
          if (!second) {
            await command.reply(`缺少服务器地址。\n${helpText}`);
            return;
          }
          let address: string;
          try {
            address = normalizeServerAddress(second);
          } catch (error) {
            await command.reply(
              `无法保存配置：${error instanceof Error ? error.message : "地址无效"}`
            );
            return;
          }
          const edition = parseEdition(third) ?? "java";
          if (third && !parseEdition(third)) {
            await command.reply("版本类型只能是 java 或 bedrock。");
            return;
          }
          await settings.set(conversationScope(command), { address, edition });
          await command.reply(
            `已将当前会话的 Minecraft 服务器设置为 ${address}（${editionLabel(edition)}）。`
          );
          return;
        }

        if (action === "reset" || action === "重置" || action === "清除") {
          if (!canConfigure(command.message.author.role)) {
            await command.reply("只有管理员或群主可以修改服务器配置。");
            return;
          }
          const removed = await settings.reset(conversationScope(command));
          await command.reply(
            removed
              ? "已清除当前会话的 Minecraft 服务器配置。"
              : "当前会话没有需要清除的服务器配置。"
          );
          return;
        }

        const configured = await settings.get(command.message);
        const explicitAddress =
          action === "status" || action === "查询" || action === "状态"
            ? second
            : first;
        const editionArgument =
          action === "status" || action === "查询" || action === "状态"
            ? third
            : second;
        if (!explicitAddress && !configured.address) {
          await command.reply(`当前会话尚未配置 Minecraft 服务器。\n${helpText}`);
          return;
        }

        let address: string;
        try {
          address = explicitAddress
            ? normalizeServerAddress(explicitAddress)
            : configured.address;
        } catch (error) {
          await command.reply(
            `无法查询：${error instanceof Error ? error.message : "地址无效"}`
          );
          return;
        }
        const parsedEdition = parseEdition(editionArgument);
        if (editionArgument && !parsedEdition) {
          await command.reply("版本类型只能是 java 或 bedrock。");
          return;
        }
        const edition = parsedEdition ?? configured.edition;

        try {
          const signal = AbortSignal.any([
            context.signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          ]);
          const status = await queryServerStatus(address, edition, signal);
          await command.reply(statusMessage(status, address, edition));
        } catch (error) {
          const message =
            error instanceof StatusQueryError
              ? error.message
              : "查询 Minecraft 服务器时发生未知错误";
          context.logger.warn({ error, address, edition }, "server query failed");
          await command.reply(`查询失败：${message}`);
        }
      }
    });
  }
});
