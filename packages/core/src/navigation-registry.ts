import type {
  ChatScope,
  CommandSummary,
  Dispose,
  NavigationItemDefinition,
  NavigationPageDefinition,
  NavigationPageSummary,
  NavigationRegistry,
  PluginHelpSummary
} from "@qq-bot/plugin-sdk";

interface RegisteredPage {
  page: NavigationPageSummary;
  order: number;
  active: boolean;
}

const allScopes: ChatScope[] = ["group", "direct", "guild"];
const idPattern = /^[a-z0-9][a-z0-9._-]*$/u;

export class BotNavigationRegistry {
  private readonly pages = new Map<string, RegisteredPage>();
  private nextOrder = 0;

  public constructor(private readonly prefix = "/") {
    if (prefix.length === 0) {
      throw new Error("command prefix cannot be empty");
    }
  }

  public forPlugin(plugin: PluginHelpSummary): NavigationRegistry {
    return {
      register: (page) => this.register(plugin, page),
      list: () => this.list()
    };
  }

  public list(): NavigationPageSummary[] {
    return [...this.pages.values()]
      .filter((entry) => entry.active)
      .sort(
        (left, right) =>
          (left.page.order ?? 0) - (right.page.order ?? 0) ||
          left.order - right.order
      )
      .map(({ page }) => ({
        ...page,
        plugin: { ...page.plugin },
        items: page.items.map((item) => ({
          ...item,
          scopes: [...item.scopes]
        }))
      }));
  }

  public validatePlugin(
    pluginName: string,
    commands: CommandSummary[]
  ): void {
    const registeredCommands = new Set(
      commands
        .filter((command) => command.plugin.name === pluginName)
        .map((command) => command.name)
    );
    for (const { page } of this.pages.values()) {
      if (page.plugin.name !== pluginName) {
        continue;
      }
      for (const item of page.items) {
        if (!registeredCommands.has(item.commandName)) {
          throw new Error(
            `navigation item "${item.id}" references unknown command "${item.commandName}" in plugin "${pluginName}"`
          );
        }
      }
    }
  }

  private register(
    plugin: PluginHelpSummary,
    definition: NavigationPageDefinition
  ): Dispose {
    const id = definition.id?.trim() || plugin.name;
    if (!idPattern.test(id)) {
      throw new Error(`invalid navigation page id "${id}"`);
    }
    if (this.pages.has(id)) {
      throw new Error(`navigation page "${id}" is already registered`);
    }
    if (definition.title !== undefined && definition.title.trim().length === 0) {
      throw new Error("navigation page title cannot be empty");
    }
    this.validateOrder(definition.order, `navigation page "${id}"`);

    const itemIds = new Set<string>();
    const items = definition.items.map((item, index) =>
      this.normalizeItem(id, item, index, itemIds)
    );
    const description = definition.description ?? plugin.description;
    const registered: RegisteredPage = {
      page: {
        id,
        plugin: { ...plugin },
        title: definition.title?.trim() || plugin.title,
        ...(description?.trim()
          ? {
              description: description.trim()
            }
          : {}),
        order: definition.order ?? plugin.order,
        items
      },
      order: this.nextOrder++,
      active: true
    };
    this.pages.set(id, registered);

    return () => {
      registered.active = false;
      if (this.pages.get(id) === registered) {
        this.pages.delete(id);
      }
    };
  }

  private normalizeItem(
    pageId: string,
    item: NavigationItemDefinition,
    index: number,
    itemIds: Set<string>
  ): NavigationPageSummary["items"][number] {
    const id = item.id?.trim() || `${pageId}-${index + 1}`;
    if (!idPattern.test(id)) {
      throw new Error(`invalid navigation item id "${id}"`);
    }
    if (itemIds.has(id)) {
      throw new Error(`duplicate navigation item id "${id}"`);
    }
    itemIds.add(id);
    if (item.label.trim().length === 0) {
      throw new Error("navigation item label cannot be empty");
    }
    if (
      item.command.trim() !== item.command ||
      item.command.length === 0 ||
      /[\s/]/u.test(item.command)
    ) {
      throw new Error(
        `navigation item "${id}" command must be a command name without a prefix or whitespace`
      );
    }
    if (
      item.args !== undefined &&
      (item.args.trim() !== item.args || item.args.length === 0)
    ) {
      throw new Error(
        `navigation item "${id}" arguments cannot be empty or contain surrounding whitespace`
      );
    }
    this.validateOrder(item.order, `navigation item "${id}"`);
    const scopes = item.scopes ?? allScopes;
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !allScopes.includes(scope))
    ) {
      throw new Error(`navigation item "${id}" has invalid scopes`);
    }

    return {
      id,
      label: item.label.trim(),
      commandName: item.command,
      command: `${this.prefix}${item.command}${item.args ? ` ${item.args}` : ""}`,
      ...(item.description?.trim()
        ? { description: item.description.trim() }
        : {}),
      ...(item.featured !== undefined ? { featured: item.featured } : {}),
      ...(item.order !== undefined ? { order: item.order } : {}),
      ...(item.permission ? { permission: item.permission } : {}),
      scopes: [...scopes]
    };
  }

  private validateOrder(value: number | undefined, subject: string): void {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isSafeInteger(value))
    ) {
      throw new Error(`${subject} order must be a finite integer`);
    }
  }
}
