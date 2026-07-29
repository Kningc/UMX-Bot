import {
  definePlugin,
  type ChatScope,
  type CommandSummary,
  type MemberRole,
  type MessageContent,
  type MessageKeyboardButton,
  type NavigationItemSummary,
  type NavigationPageSummary
} from "@qq-bot/plugin-sdk";

const roleWeight: Record<MemberRole, number> = {
  member: 0,
  admin: 1,
  owner: 2
};

function canUse(item: NavigationItemSummary, role: MemberRole): boolean {
  return roleWeight[role] >= roleWeight[item.permission ?? "member"];
}

function canUseCommand(command: CommandSummary, role: MemberRole): boolean {
  return !command.hidden && roleWeight[role] >= roleWeight[command.permission];
}

function availableItems(
  page: NavigationPageSummary,
  scope: ChatScope,
  role: MemberRole
): NavigationItemSummary[] {
  return page.items
    .filter((item) => item.scopes.includes(scope) && canUse(item, role))
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.label.localeCompare(right.label, "zh-CN")
    );
}

function button(
  id: string,
  label: string,
  command: string,
  primary = false
): MessageKeyboardButton {
  return {
    id,
    label: label.slice(0, 20),
    command,
    style: primary ? 1 : 0,
    enter: true
  };
}

function keyboard(buttons: MessageKeyboardButton[]) {
  const visible = buttons.slice(0, 10);
  const rows: MessageKeyboardButton[][] = [];
  for (let index = 0; index < visible.length; index += 2) {
    rows.push(visible.slice(index, index + 2));
  }
  return rows.length > 0 ? { rows } : undefined;
}

function lineForItem(item: NavigationItemSummary): string {
  return `- **${item.label}**：${item.description ?? item.command} \`${item.command}\``;
}

function linesForCommand(command: CommandSummary): string[] {
  const lines = [
    `### \`${command.invocation}\``,
    command.description,
    `- 用法：\`${command.usage}\``
  ];
  if (command.aliases.length > 0) {
    lines.push(
      `- 别名：${command.aliasInvocations.map((alias) => `\`${alias}\``).join("、")}`
    );
  }
  if (command.permission !== "member") {
    lines.push(
      `- 权限：${command.permission === "owner" ? "群主" : "管理员及群主"}`
    );
  }
  if (command.examples.length > 0) {
    lines.push(
      "- 示例：",
      ...command.examples.map(
        (example) =>
          `  - \`${example.command}\`${example.description ? ` — ${example.description}` : ""}`
      )
    );
  }
  return lines;
}

export interface HelpRenderInput {
  pages: NavigationPageSummary[];
  commands: CommandSummary[];
  scope: ChatScope;
  role: MemberRole;
  helpCommand: string;
  query?: string;
}

export function renderHelp({
  pages,
  commands,
  scope,
  role,
  helpCommand,
  query
}: HelpRenderInput): MessageContent {
  const availableCommands = commands.filter(
    (command) => command.plugin.listed && canUseCommand(command, role)
  );
  const navigationPages = pages
    .filter((page) => page.plugin.listed)
    .map((page) => ({
      page,
      items: availableItems(page, scope, role),
      commands: availableCommands.filter(
        (command) => command.plugin.name === page.plugin.name
      )
    }))
    .filter(({ items, commands: pageCommands }) =>
      items.length > 0 || pageCommands.length > 0
    );
  const pluginsWithPages = new Set(
    navigationPages.map(({ page }) => page.plugin.name)
  );
  const commandOnlyPages: Array<{
    page: NavigationPageSummary;
    items: NavigationItemSummary[];
    commands: CommandSummary[];
  }> = [
    ...new Map(
      availableCommands.map((command) => [
        command.plugin.name,
        command.plugin
      ])
    ).values()
  ]
    .filter((plugin) => !pluginsWithPages.has(plugin.name))
    .map((plugin) => ({
      page: {
        id: plugin.name,
        plugin,
        title: plugin.title,
        ...(plugin.description
          ? { description: plugin.description }
          : {}),
        order: plugin.order,
        items: []
      },
      items: [],
      commands: availableCommands.filter(
        (command) => command.plugin.name === plugin.name
      )
    }));
  const availablePages = [...navigationPages, ...commandOnlyPages].sort(
    (left, right) =>
      (left.page.order ?? left.page.plugin.order) -
        (right.page.order ?? right.page.plugin.order) ||
      left.page.title.localeCompare(right.page.title, "zh-CN")
  );

  if (query) {
    const selected = availablePages.find(
      ({ page, commands: pageCommands }) =>
        page.id === query ||
        page.plugin.name === query ||
        pageCommands.some(
          (command) =>
            command.name === query || command.aliases.includes(query)
        )
    );
    if (!selected) {
      return `没有找到可用的插件或命令：${query}`;
    }
    const markdown = [
      `# ${selected.page.title}`,
      selected.page.description ?? "",
      ...(selected.items.length > 0
        ? ["", "## 快捷操作", ...selected.items.map(lineForItem)]
        : []),
      ...(selected.commands.length > 0
        ? [
            "",
            "## 命令帮助",
            ...selected.commands.flatMap(linesForCommand)
          ]
        : []),
      "",
      "点击下方按钮即可直接发送指令。"
    ]
      .filter((line, index, lines) => line || lines[index - 1] !== "")
      .join("\n");
    const buttons = selected.items.map((item, index) =>
      button(
        `nav-${selected.page.id}-${index + 1}`,
        item.label,
        item.command,
        index === 0
      )
    );
    buttons.push(button("nav-home", "返回主导航", helpCommand));
    const messageKeyboard = keyboard(buttons);
    return {
      text: [
        `${selected.page.title}：`,
        ...selected.commands.map(
          (command) => `${command.usage} - ${command.description}`
        ),
        ...selected.items.map((item) => `${item.label} - ${item.command}`)
      ].join("\n"),
      markdown,
      ...(messageKeyboard ? { keyboard: messageKeyboard } : {})
    };
  }

  const featured = availablePages.flatMap(({ items }) =>
    items.filter((item) => item.featured)
  );
  const markdown = [
    "# UMX Bot 导航",
    `点击按钮即可直接发送命令；使用 \`${helpCommand} <插件或命令>\` 查看完整用法。`,
    ...(featured.length > 0
      ? ["", "## 常用指令", ...featured.map(lineForItem)]
      : []),
    ...(availablePages.length > 0
      ? [
          "",
          "## 插件导航",
          ...availablePages.map(
            ({ page, items, commands: pageCommands }) =>
              `- **${page.title}**：${page.description ?? `${items.length + pageCommands.length} 个可用入口`}`
          )
        ]
      : [])
  ].join("\n");
  const buttons = [
    ...featured.map((item, index) =>
      button(`featured-${index + 1}`, item.label, item.command, true)
    ),
    ...availablePages.map(({ page }, index) =>
      button(
        `page-${index + 1}`,
        page.title,
        `${helpCommand} ${page.id}`
      )
    )
  ];
  const messageKeyboard = keyboard(buttons);
  return {
    text: [
      "UMX Bot 导航",
      ...featured.map((item) => `${item.label} - ${item.command}`),
      ...availablePages.map(
        ({ page }) => `${page.title} - ${helpCommand} ${page.id}`
      )
    ].join("\n"),
    markdown,
    ...(messageKeyboard ? { keyboard: messageKeyboard } : {})
  };
}

export function isMentionOnly(content: string): boolean {
  const withoutMarkup = content
    .replace(/<@!?\d+>/gu, "")
    .replace(/\u200b/gu, "")
    .trim();
  return withoutMarkup.length === 0 || /^@\S+$/u.test(withoutMarkup);
}

export default definePlugin({
  name: "help",
  version: "0.4.0",
  description: "显示可点击的插件导航与命令帮助",
  help: {
    listed: false
  },
  setup(context) {
    const helpCommand = context.commands.format("help");
    context.middleware.use(
      async (message, next) => {
        if (
          message.message.scope === "group" &&
          message.message.botMentioned &&
          message.message.attachments.length === 0 &&
          isMentionOnly(message.message.content)
        ) {
          message.handled = true;
          await message.reply(
            renderHelp({
              pages: context.navigation.list(),
              commands: context.commands.list(),
              scope: message.message.scope,
              role: message.message.author.role,
              helpCommand
            })
          );
          return;
        }
        await next();
      },
      { priority: 1_000 }
    );

    context.commands.register({
      name: "help",
      description: "显示可点击的插件导航",
      aliases: ["帮助"],
      usage: "[插件或命令]",
      examples: [
        { description: "打开主导航" },
        { args: "<插件或命令>", description: "查看完整帮助" }
      ],
      execute(command) {
        return command.reply(
          renderHelp({
            pages: context.navigation.list(),
            commands: context.commands.list(),
            scope: command.message.scope,
            role: command.message.author.role,
            helpCommand,
            ...(command.args[0] ? { query: command.args[0] } : {})
          })
        );
      }
    });
  }
});
