import type { Dispose, ScopedSettings } from "@qq-bot/plugin-sdk";

export interface SettingsCatalogEntry {
  plugin: string;
  key: string;
  defaults: object;
  settings: ScopedSettings<object>;
}

/**
 * Every settings definition made by a loaded plugin.
 *
 * Settings are typed per plugin, so the framework could not otherwise offer a
 * generic way to inspect or change them. The catalog is what lets one admin
 * command edit any plugin's settings without knowing its shape.
 */
export class SettingsCatalog {
  private readonly entries: SettingsCatalogEntry[] = [];

  public register(entry: SettingsCatalogEntry): Dispose {
    this.entries.push(entry);
    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) {
        this.entries.splice(index, 1);
      }
    };
  }

  public list(): SettingsCatalogEntry[] {
    return [...this.entries].sort(
      (left, right) =>
        left.plugin.localeCompare(right.plugin) ||
        left.key.localeCompare(right.key)
    );
  }

  public find(
    plugin: string,
    key = "default"
  ): SettingsCatalogEntry | undefined {
    return this.entries.find(
      (entry) => entry.plugin === plugin && entry.key === key
    );
  }
}
