import { readFile } from "node:fs/promises";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_API_BASE_URL = "https://api.bot.qq.com";
const scopes = new Set(["c2c", "group", "channel", "dm"]);

function displayLength(value) {
  return [...value].reduce(
    (length, character) => length + (/^[\x00-\x7f]$/u.test(character) ? 1 : 2),
    0
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function containsExpected(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsExpected(actual[index], value))
    );
  }
  if (expected && typeof expected === "object") {
    return (
      actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) =>
        containsExpected(actual[key], value)
      )
    );
  }
  return Object.is(actual, expected);
}

function validateMenuItem(item, path, nested = false) {
  assert(item && typeof item === "object", `${path} must be an object`);
  assert(typeof item.name === "string" && item.name.length > 0, `${path}.name is required`);
  assert(
    displayLength(item.name) <= (nested ? 14 : 10),
    `${path}.name exceeds the QQ display-length limit`
  );
  const allowedTypes = nested
    ? new Set(["send_message", "link"])
    : new Set(["send_message", "link", "switch", "menu"]);
  assert(allowedTypes.has(item.type), `${path}.type is invalid`);
  if (item.type === "send_message") {
    assert(typeof item.send_message === "string" && item.send_message.length > 0, `${path}.send_message is required`);
  } else if (item.type === "link") {
    assert(typeof item.link === "string" && item.link.startsWith("https://"), `${path}.link must use HTTPS`);
  } else if (item.type === "switch") {
    assert(item.switch && typeof item.switch.switch_id === "string", `${path}.switch.switch_id is required`);
  } else {
    assert(Array.isArray(item.sub_menu_items), `${path}.sub_menu_items is required`);
    assert(item.sub_menu_items.length <= 5, `${path}.sub_menu_items exceeds 5 items`);
    item.sub_menu_items.forEach((child, index) =>
      validateMenuItem(child, `${path}.sub_menu_items[${index}]`, true)
    );
  }
}

function validatePanel(panel, index) {
  const path = `panels[${index}]`;
  assert(panel && typeof panel === "object", `${path} must be an object`);
  assert(scopes.has(panel.scope), `${path}.scope is invalid`);
  assert(panel.target_type === "all" || panel.target_type === "specific", `${path}.target_type is invalid`);
  assert(
    !["channel", "dm"].includes(panel.scope) || panel.target_type === "all",
    `${path} must use target_type=all for channel/dm`
  );
  assert(panel.panel && Array.isArray(panel.panel.items), `${path}.panel.items is required`);
  assert(panel.panel.items.length <= 20, `${path}.panel.items exceeds 20 items`);
  assert(
    typeof panel.panel.remark === "string" && panel.panel.remark.startsWith("qq-bot-managed:"),
    `${path}.panel.remark must use the qq-bot-managed: prefix`
  );
  panel.panel.items.forEach((item, itemIndex) => {
    const itemPath = `${path}.panel.items[${itemIndex}]`;
    assert(item && typeof item === "object", `${itemPath} must be an object`);
    assert(item.type === "command" || item.type === "link", `${itemPath}.type is invalid`);
    assert(typeof item.name === "string" && item.name.length > 0, `${itemPath}.name is required`);
    assert(displayLength(item.name) <= 14, `${itemPath}.name exceeds the QQ display-length limit`);
    if (item.desc !== undefined) {
      assert(typeof item.desc === "string" && displayLength(item.desc) <= 30, `${itemPath}.desc exceeds the QQ display-length limit`);
    }
    if (item.type === "link") {
      assert(typeof item.link === "string" && item.link.startsWith("https://"), `${itemPath}.link must use HTTPS`);
    }
  });
}

function validateConfig(config) {
  assert(config && typeof config === "object", "menu config must be an object");
  assert(config.menu && Array.isArray(config.menu.items), "menu.items is required");
  assert(config.menu.items.length <= 10, "menu.items exceeds 10 items");
  config.menu.items.forEach((item, index) => validateMenuItem(item, `menu.items[${index}]`));
  assert(Array.isArray(config.panels), "panels is required");
  config.panels.forEach(validatePanel);
  const remarks = config.panels.map((panel) => panel.panel.remark);
  assert(new Set(remarks).size === remarks.length, "panel remarks must be unique");
}

async function readJson(response, endpoint) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${endpoint} returned invalid JSON (${response.status})`);
  }
  const businessCode = payload?.err_code ?? payload?.code;
  if (!response.ok || (businessCode !== undefined && ![0, "0"].includes(businessCode))) {
    const detail = payload?.message ?? payload?.msg ?? text ?? "unknown error";
    throw new Error(`${endpoint} failed (${response.status}, code ${businessCode ?? "unknown"}): ${detail}`);
  }
  return payload;
}

async function getAccessToken(appId, clientSecret) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await readJson(response, "access token request");
  assert(typeof payload.access_token === "string" && payload.access_token.length > 0, "access token response is incomplete");
  return payload.access_token;
}

function createApi(baseUrl, accessToken) {
  return async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000)
    });
    return readJson(response, `${method} ${path}`);
  };
}

async function syncPanel(api, desired) {
  const query = new URLSearchParams({ scope: desired.scope, limit: "50" });
  const list = await api("GET", `/v2/panels?${query}`);
  const matches = (list.records ?? []).filter(
    (record) => record?.panel?.remark === desired.panel.remark
  );
  assert(matches.length <= 1, `multiple panels use remark ${desired.panel.remark}`);
  if (matches.length === 1) {
    const panelId = matches[0].panel_id;
    assert(typeof panelId === "string" && panelId.length > 0, "existing panel has no panel_id");
    const result = await api("PUT", `/v2/panels/${encodeURIComponent(panelId)}`, {
      panel: desired.panel
    });
    return { action: "updated", scope: desired.scope, panelId, version: result.version };
  }
  const result = await api("POST", "/v2/panels", desired);
  return { action: "created", scope: desired.scope, panelId: result.panel_id };
}

async function verifyRemoteConfig(api, config) {
  const currentMenu = await api("GET", "/v2/menu");
  assert(
    containsExpected(currentMenu.menu?.items, config.menu.items),
    "live custom menu does not match deploy/qq-menu.json"
  );
  const panels = [];
  for (const desired of config.panels) {
    const query = new URLSearchParams({ scope: desired.scope, limit: "50" });
    const list = await api("GET", `/v2/panels?${query}`);
    const matches = (list.records ?? []).filter(
      (record) => record?.panel?.remark === desired.panel.remark
    );
    assert(matches.length === 1, `expected one live panel with remark ${desired.panel.remark}`);
    const live = matches[0];
    assert(live.scope === desired.scope, `${desired.scope} panel scope does not match`);
    assert(live.target_type === desired.target_type, `${desired.scope} panel target_type does not match`);
    assert(
      containsExpected(live.panel?.items, desired.panel.items),
      `${desired.scope} panel items do not match deploy/qq-menu.json: ${JSON.stringify(live.panel?.items)}`
    );
    panels.push({ scope: desired.scope, panelId: live.panel_id, version: live.version });
  }
  return { menuVersion: currentMenu.version, panels };
}

const [configPath, mode] = process.argv.slice(2);
assert(configPath, "usage: node scripts/sync-qq-menu.mjs <config.json> [--validate-only]");
const config = JSON.parse(await readFile(configPath, "utf8"));
validateConfig(config);

if (mode === "--validate-only") {
  console.log(`QQ menu configuration is valid (${config.menu.items.length} menu items, ${config.panels.length} panels)`);
  process.exit(0);
}

const appId = process.env.QQ_APP_ID;
const clientSecret = process.env.QQ_CLIENT_SECRET;
assert(appId, "QQ_APP_ID is required");
assert(clientSecret, "QQ_CLIENT_SECRET is required");
const apiBaseUrl = (process.env.QQ_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/u, "");
const accessToken = await getAccessToken(appId, clientSecret);
const api = createApi(apiBaseUrl, accessToken);

if (mode === "--verify-only") {
  const verified = await verifyRemoteConfig(api, config);
  console.log(`live menu verified (version ${verified.menuVersion})`);
  for (const panel of verified.panels) {
    console.log(`${panel.scope} panel verified (${panel.panelId}, version ${panel.version})`);
  }
  process.exit(0);
}

const menuResult = await api("PUT", "/v2/menu", { menu: config.menu });
console.log(`menu updated (version ${menuResult.version})`);
for (const panel of config.panels) {
  const result = await syncPanel(api, panel);
  console.log(`${result.scope} panel ${result.action} (${result.panelId}${result.version === undefined ? "" : `, version ${result.version}`})`);
}
const verified = await verifyRemoteConfig(api, config);
console.log(`live configuration verified (menu version ${verified.menuVersion})`);
