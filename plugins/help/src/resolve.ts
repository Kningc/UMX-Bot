import type { CommandSummary, SubcommandSummary } from "@umx-bot/plugin-sdk";
import type { HelpCatalog, HelpSection } from "./catalog.js";

export interface HelpSuggestion {
  label: string;
  /** What to pass back to `/help` to open it. */
  query: string;
}

export type HelpView =
  | { kind: "home"; page: number }
  | { kind: "section"; section: HelpSection }
  | { kind: "command"; section: HelpSection; command: CommandSummary }
  | {
      kind: "subcommand";
      section: HelpSection;
      command: CommandSummary;
      subcommand: SubcommandSummary;
    }
  | { kind: "notFound"; query: string; suggestions: HelpSuggestion[] };

const MAX_SUGGESTIONS = 5;

const normalize = (value: string) => value.trim().toLowerCase();

function findCommand(
  catalog: HelpCatalog,
  name: string
): { section: HelpSection; command: CommandSummary } | undefined {
  for (const section of catalog.sections) {
    for (const command of section.commands) {
      if (
        normalize(command.name) === name ||
        command.aliases.some((alias) => normalize(alias) === name)
      ) {
        return { section, command };
      }
    }
  }
  return undefined;
}

function findSubcommand(
  command: CommandSummary,
  name: string
): SubcommandSummary | undefined {
  return command.subcommands?.find(
    (sub) =>
      normalize(sub.name) === name ||
      sub.aliases.some((alias) => normalize(alias) === name)
  );
}

function commandView(
  section: HelpSection,
  command: CommandSummary,
  subName: string | undefined
): HelpView {
  const subcommand =
    subName === undefined ? undefined : findSubcommand(command, subName);
  return subcommand
    ? { kind: "subcommand", section, command, subcommand }
    : { kind: "command", section, command };
}

interface Candidate {
  label: string;
  query: string;
  view: HelpView;
  /** Lower ranks first: 0 name prefix, 1 name contains, 2 description. */
  rank: number;
}

function rank(
  needle: string,
  names: readonly string[],
  description: string | undefined
): number | undefined {
  const lowered = names.map(normalize);
  if (lowered.some((name) => name.startsWith(needle))) {
    return 0;
  }
  if (lowered.some((name) => name.includes(needle))) {
    return 1;
  }
  if (description && normalize(description).includes(needle)) {
    return 2;
  }
  return undefined;
}

function search(catalog: HelpCatalog, needle: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const section of catalog.sections) {
    const sectionRank = rank(
      needle,
      [section.id, section.plugin.name, section.title],
      section.description
    );
    if (sectionRank !== undefined) {
      candidates.push({
        label: section.title,
        query: section.id,
        view: { kind: "section", section },
        rank: sectionRank
      });
    }
    for (const command of section.commands) {
      const commandRank = rank(
        needle,
        [command.name, ...command.aliases],
        command.description
      );
      if (commandRank !== undefined) {
        candidates.push({
          label: command.invocation,
          query: command.name,
          view: { kind: "command", section, command },
          rank: commandRank
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.rank - right.rank || left.label.localeCompare(right.label, "zh-CN")
  );
}

/**
 * Works out what `/help <query>` should show. Tries, in order: a page number
 * of the main navigation, a command (and subcommand) by name or alias, a
 * section by id, plugin name or title, then a substring search that opens the
 * only hit or lists the best few.
 */
export function resolveHelp(
  catalog: HelpCatalog,
  query: string | undefined,
  prefix: string
): HelpView {
  const raw = query?.trim() ?? "";
  if (raw.length === 0) {
    return { kind: "home", page: 1 };
  }
  if (/^\d+$/u.test(raw)) {
    return { kind: "home", page: Number.parseInt(raw, 10) };
  }

  const tokens = raw.split(/\s+/u);
  const first = normalize(
    tokens[0]?.startsWith(prefix)
      ? tokens[0].slice(prefix.length)
      : (tokens[0] ?? "")
  );
  const found = findCommand(catalog, first);
  if (found) {
    return commandView(
      found.section,
      found.command,
      tokens[1] === undefined ? undefined : normalize(tokens[1])
    );
  }

  const whole = normalize(raw);
  const section = catalog.sections.find(
    (candidate) =>
      normalize(candidate.id) === whole ||
      normalize(candidate.plugin.name) === whole ||
      normalize(candidate.title) === whole
  );
  if (section) {
    return { kind: "section", section };
  }

  const needle = whole.startsWith(prefix) ? whole.slice(prefix.length) : whole;
  const hits = needle.length > 0 ? search(catalog, needle) : [];
  if (hits.length === 1 && hits[0]) {
    return hits[0].view;
  }
  return {
    kind: "notFound",
    query: raw,
    suggestions: hits
      .slice(0, MAX_SUGGESTIONS)
      .map(({ label, query: target }) => ({ label, query: target }))
  };
}
