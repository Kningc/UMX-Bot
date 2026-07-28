import {
  definePlugin,
  type ChatScope,
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

export function renderNavigation(
  pages: NavigationPageSummary[],
  scope: ChatScope,
  role: MemberRole,
  pageId?: string
): MessageContent {
  const availablePages = pages
    .map((page) => ({
      page,
      items: availableItems(page, scope, role)
    }))
    .filter(({ items }) => items.length > 0);

  if (pageId) {
    const selected = availablePages.find(({ page }) => page.id === pageId);
    if (!selected) {
      return `没有找到可用的插件导航页：${pageId}`;
    }
    const markdown = [
      `# ${selected.page.title}`,
      selected.page.description ?? "",
      "",
      ...selected.items.map(lineForItem),
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
    buttons.push(button("nav-home", "返回主导航", "/help"));
    const messageKeyboard = keyboard(buttons);
    return {
      text: [
        `${selected.page.title}：`,
        ...selected.items.map(
          (item) => `${item.label} - ${item.command}`
        )
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
    "点击按钮即可直接发送命令；也可以手动输入下面的指令。",
    ...(featured.length > 0
      ? ["", "## 常用指令", ...featured.map(lineForItem)]
      : []),
    ...(availablePages.length > 0
      ? [
          "",
          "## 插件导航",
          ...availablePages.map(
            ({ page, items }) =>
              `- **${page.title}**：${page.description ?? `${items.length} 个可用操作`}`
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
        `/help ${page.id}`
      )
    )
  ];
  const messageKeyboard = keyboard(buttons);
  return {
    text: [
      "UMX Bot 导航",
      ...featured.map((item) => `${item.label} - ${item.command}`),
      ...availablePages.map(
        ({ page }) => `${page.title} - /help ${page.id}`
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
  setup(context) {
    context.navigation.register({
      title: "帮助",
      description: "查看机器人和插件导航",
      order: -100,
      items: [
        {
          id: "help",
          label: "主导航",
          command: "/help",
          description: "返回主导航"
        }
      ]
    });

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
            renderNavigation(
              context.navigation.list(),
              message.message.scope,
              message.message.author.role
            )
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
      usage: "/help [插件导航页]",
      execute(command) {
        return command.reply(
          renderNavigation(
            context.navigation.list(),
            command.message.scope,
            command.message.author.role,
            command.args[0]
          )
        );
      }
    });
  }
});
