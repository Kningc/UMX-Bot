import type {
  CommandSummary,
  NavigationItemSummary,
  NavigationPageSummary,
  PluginHelpSummary
} from "@umx-bot/plugin-sdk";

/** One plugin's corner of the help: its quick actions and its commands. */
export interface HelpSection {
  /** What `/help <id>` opens: the navigation page id, else the plugin name. */
  id: string;
  plugin: PluginHelpSummary;
  title: string;
  description?: string;
  order: number;
  /** Quick-action buttons, in display order. */
  items: NavigationItemSummary[];
  commands: CommandSummary[];
}

/** Everything one person can use in one chat, grouped for display. */
export interface HelpCatalog {
  sections: HelpSection[];
  /** Items marked `featured`, across all sections, in section order. */
  featured: NavigationItemSummary[];
}

const byOrderThenLabel = (
  left: { order?: number; label: string },
  right: { order?: number; label: string }
) =>
  (left.order ?? 0) - (right.order ?? 0) ||
  left.label.localeCompare(right.label, "zh-CN");

/**
 * Groups what the author may use into sections. `pages` and `commands` must
 * already be filtered for the author and chat (the registries' `available`);
 * this only drops unlisted plugins and items not meant for messages.
 */
export function buildCatalog(
  pages: readonly NavigationPageSummary[],
  commands: readonly CommandSummary[]
): HelpCatalog {
  const listedCommands = commands.filter((command) => command.plugin.listed);
  const sections: HelpSection[] = [];
  const pluginsWithPages = new Set<string>();

  for (const page of pages) {
    if (!page.plugin.listed) {
      continue;
    }
    const items = page.items
      .filter((item) => item.surfaces.includes("message"))
      .sort(byOrderThenLabel);
    // A plugin may register several pages; its commands go to the first one.
    const pageCommands = pluginsWithPages.has(page.plugin.name)
      ? []
      : listedCommands.filter(
          (command) => command.plugin.name === page.plugin.name
        );
    if (items.length === 0 && pageCommands.length === 0) {
      continue;
    }
    pluginsWithPages.add(page.plugin.name);
    sections.push({
      id: page.id,
      plugin: page.plugin,
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      order: page.order ?? page.plugin.order,
      items,
      commands: pageCommands
    });
  }

  const commandOnly = new Map<string, HelpSection>();
  for (const command of listedCommands) {
    const plugin = command.plugin;
    if (pluginsWithPages.has(plugin.name)) {
      continue;
    }
    const section = commandOnly.get(plugin.name) ?? {
      id: plugin.name,
      plugin,
      title: plugin.title,
      ...(plugin.description ? { description: plugin.description } : {}),
      order: plugin.order,
      items: [],
      commands: []
    };
    section.commands.push(command);
    commandOnly.set(plugin.name, section);
  }
  sections.push(...commandOnly.values());

  sections.sort(
    (left, right) =>
      left.order - right.order || left.title.localeCompare(right.title, "zh-CN")
  );
  return {
    sections,
    featured: sections.flatMap((section) =>
      section.items.filter((item) => item.featured)
    )
  };
}
