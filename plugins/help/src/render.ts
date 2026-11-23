import type {
  CommandSummary,
  MemberRole,
  MessageKeyboardButton,
  NavigationItemSummary,
  RichMessageContent,
  SubcommandSummary
} from "@umx-bot/plugin-sdk";
import type { HelpCatalog, HelpSection } from "./catalog.js";
import type { HelpView } from "./resolve.js";

export interface HelpRenderOptions {
  /** The help command with the configured prefix, such as `/help`. */
  helpCommand: string;
  /** Heading of the main navigation. */
  title: string;
}

/** QQ shows at most 5 rows of buttons; we use 2 per row for phones. */
const BUTTONS_PER_ROW = 2;
const MAX_BUTTONS = 10;
/** With paging, one row is kept for the previous/next buttons. */
const BUTTONS_PER_PAGE = MAX_BUTTONS - BUTTONS_PER_ROW;
const MAX_LABEL_LENGTH = 10;

const permissionLabel: Record<MemberRole, string | undefined> = {
  member: undefined,
  admin: "管理员及以上",
  owner: "群主或机器人主人"
};

function label(text: string): string {
  return text.length > MAX_LABEL_LENGTH
    ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : text;
}

function runButton(
  id: string,
  text: string,
  command: string,
  primary = false
): MessageKeyboardButton {
  return {
    id,
    label: label(text),
    action: "command",
    data: command,
    style: primary ? "primary" : "default",
    enter: true
  };
}

function keyboardOf(
  buttons: readonly MessageKeyboardButton[]
): RichMessageContent["keyboard"] {
  const rows: MessageKeyboardButton[][] = [];
  for (const button of buttons.slice(0, MAX_BUTTONS)) {
    const last = rows.at(-1);
    if (last && last.length < BUTTONS_PER_ROW) {
      last.push(button);
    } else {
      rows.push([button]);
    }
  }
  return rows.length > 0 ? { rows } : undefined;
}

/**
 * The plain-text fallback is the Markdown with its markup removed, so both
 * always say the same thing.
 */
function toPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/u, "")
        .replace(/\*\*(.+?)\*\*/gu, "$1")
        .replace(/`([^`]*)`/gu, "$1")
    )
    .join("\n");
}

function message(
  lines: readonly string[],
  buttons: readonly MessageKeyboardButton[]
): RichMessageContent {
  // Collapse runs of blank lines left by empty optional parts.
  const markdown = lines
    .filter((line, index) => line !== "" || (index > 0 && lines[index - 1]))
    .join("\n")
    .trim();
  const keyboard = keyboardOf(buttons);
  return {
    text: toPlainText(markdown),
    markdown,
    ...(keyboard ? { keyboard } : {})
  };
}

function itemLine(item: NavigationItemSummary): string {
  return `- **${item.label}**：${item.description ?? item.command} \`${item.command}\``;
}

function detailLines(
  entry: CommandSummary | SubcommandSummary,
  aliasInvocations: readonly string[]
): string[] {
  const lines = [entry.description, `- 用法：\`${entry.usage}\``];
  if (aliasInvocations.length > 0) {
    lines.push(
      `- 别名：${aliasInvocations.map((alias) => `\`${alias}\``).join("、")}`
    );
  }
  const permission = entry.botOwnerOnly
    ? "仅机器人主人"
    : permissionLabel[entry.permission];
  if (permission) {
    lines.push(`- 权限：${permission}`);
  }
  if (entry.examples.length > 0) {
    lines.push(
      "- 示例：",
      ...entry.examples.map(
        (example) =>
          `  - \`${example.command}\`${example.description ? ` — ${example.description}` : ""}`
      )
    );
  }
  return lines;
}

function commandLines(command: CommandSummary): string[] {
  const lines = detailLines(command, command.aliasInvocations);
  const subcommands = command.subcommands ?? [];
  if (subcommands.length > 0) {
    lines.push(
      "- 子命令：",
      ...subcommands.map((sub) => `  - \`${sub.usage}\` — ${sub.description}`)
    );
  }
  return lines;
}

function renderHome(
  catalog: HelpCatalog,
  requestedPage: number,
  { helpCommand, title }: HelpRenderOptions
): RichMessageContent | string {
  if (catalog.sections.length === 0) {
    return "当前没有你可以使用的功能。";
  }
  const buttons = [
    ...catalog.featured.map((item, index) =>
      runButton(`featured-${index + 1}`, item.label, item.command, true)
    ),
    ...catalog.sections.map((section, index) =>
      runButton(
        `section-${index + 1}`,
        section.title,
        `${helpCommand} ${section.id}`
      )
    )
  ];
  const paged = buttons.length > MAX_BUTTONS;
  const pageCount = paged ? Math.ceil(buttons.length / BUTTONS_PER_PAGE) : 1;
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const pageButtons = paged
    ? buttons.slice((page - 1) * BUTTONS_PER_PAGE, page * BUTTONS_PER_PAGE)
    : buttons;
  if (paged) {
    if (page > 1) {
      pageButtons.push(
        runButton("page-prev", "上一页", `${helpCommand} ${page - 1}`)
      );
    }
    if (page < pageCount) {
      pageButtons.push(
        runButton("page-next", "下一页", `${helpCommand} ${page + 1}`)
      );
    }
  }

  // Kept to a few lines: the buttons carry the entries, and a bare @ in a
  // busy group should not flood it. Commands stay in the text so it still
  // works where QQ withholds the keyboard.
  const featured = catalog.featured
    .map((item) => `**${item.label}** \`${item.command}\``)
    .join("　");
  const sections = catalog.sections.map((section) => section.title).join(" · ");
  return message(
    [
      `### ${title}`,
      ...(featured ? [`常用：${featured}`] : []),
      `功能：${sections}`,
      `发送 \`${helpCommand} 名称\` 查看用法${
        paged && page < pageCount
          ? `，\`${helpCommand} ${page + 1}\` 看更多按钮`
          : ""
      }`
    ],
    pageButtons
  );
}

function homeButton(helpCommand: string): MessageKeyboardButton {
  return runButton("home", "返回主导航", helpCommand);
}

function renderSection(
  section: HelpSection,
  { helpCommand }: HelpRenderOptions
): RichMessageContent {
  const single =
    section.commands.length === 1 ? section.commands[0] : undefined;
  const lines = [
    `# ${section.title}`,
    section.description ?? "",
    ...(section.items.length > 0
      ? ["", "## 快捷操作", ...section.items.map(itemLine)]
      : [])
  ];
  if (single) {
    lines.push("", `## \`${single.invocation}\``, ...commandLines(single));
  } else if (section.commands.length > 0) {
    lines.push(
      "",
      "## 命令",
      ...section.commands.map(
        (command) => `- \`${command.usage}\` — ${command.description}`
      ),
      "",
      `发送 \`${helpCommand} <命令>\` 查看某个命令的完整用法。`
    );
  }

  const buttons = section.items.map((item, index) =>
    runButton(`item-${index + 1}`, item.label, item.command, index === 0)
  );
  if (!single) {
    buttons.push(
      ...section.commands.map((command, index) =>
        runButton(
          `command-${index + 1}`,
          command.invocation,
          `${helpCommand} ${command.name}`
        )
      )
    );
  }
  return message(lines, [
    ...buttons.slice(0, MAX_BUTTONS - 1),
    homeButton(helpCommand)
  ]);
}

function backButtons(
  section: HelpSection,
  helpCommand: string
): MessageKeyboardButton[] {
  return section.commands.length > 1 || section.items.length > 0
    ? [
        runButton(
          "back",
          `返回${section.title}`,
          `${helpCommand} ${section.id}`
        ),
        homeButton(helpCommand)
      ]
    : [homeButton(helpCommand)];
}

function renderCommand(
  section: HelpSection,
  command: CommandSummary,
  { helpCommand }: HelpRenderOptions
): RichMessageContent {
  const back = backButtons(section, helpCommand);
  const subButtons = (command.subcommands ?? []).map((sub, index) =>
    runButton(
      `sub-${index + 1}`,
      sub.name,
      `${helpCommand} ${command.name} ${sub.name}`
    )
  );
  return message(
    [`# \`${command.invocation}\``, ...commandLines(command)],
    [...subButtons.slice(0, MAX_BUTTONS - back.length), ...back]
  );
}

function renderSubcommand(
  command: CommandSummary,
  subcommand: SubcommandSummary,
  { helpCommand }: HelpRenderOptions
): RichMessageContent {
  const aliases = subcommand.aliases.map(
    (alias) => `${command.invocation} ${alias}`
  );
  return message(
    [`# \`${subcommand.invocation}\``, ...detailLines(subcommand, aliases)],
    [
      runButton(
        "back",
        `返回${command.invocation}`,
        `${helpCommand} ${command.name}`
      ),
      homeButton(helpCommand)
    ]
  );
}

export function renderView(
  view: HelpView,
  catalog: HelpCatalog,
  options: HelpRenderOptions
): RichMessageContent | string {
  switch (view.kind) {
    case "home":
      return renderHome(catalog, view.page, options);
    case "section":
      return renderSection(view.section, options);
    case "command":
      return renderCommand(view.section, view.command, options);
    case "subcommand":
      return renderSubcommand(view.command, view.subcommand, options);
    case "notFound":
      return message(
        [
          `没有找到「${view.query}」。`,
          ...(view.suggestions.length > 0
            ? [
                "",
                "你可能想找：",
                ...view.suggestions.map(
                  (suggestion) =>
                    `- \`${options.helpCommand} ${suggestion.query}\` — ${suggestion.label}`
                )
              ]
            : ["", `发送 \`${options.helpCommand}\` 查看全部功能。`])
        ],
        [
          ...view.suggestions.map((suggestion, index) =>
            runButton(
              `suggestion-${index + 1}`,
              suggestion.label,
              `${options.helpCommand} ${suggestion.query}`
            )
          ),
          homeButton(options.helpCommand)
        ]
      );
  }
}
