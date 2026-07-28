import type {
  ChatScope,
  ConversationRef,
  DeepPartial,
  KeyValueStore,
  ScopedSettings,
  ScopedStateRegistry,
  SettingsDefinition,
  SettingsInspection,
  SettingsRegistry,
  SettingsScope
} from "@qq-bot/plugin-sdk";

interface StoredSettings {
  version: number;
  overrides: unknown;
}

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} cannot be empty`);
  }
}

function assertScope(scope: SettingsScope): void {
  if (scope.level !== "global") {
    assertNonEmpty(scope.platform, "settings scope platform");
  }
  if (scope.level === "conversation") {
    assertNonEmpty(scope.conversationId, "settings scope conversationId");
  }
}

function scopeKey(scope: SettingsScope): string {
  assertScope(scope);
  switch (scope.level) {
    case "global":
      return "global";
    case "platform":
      return `platform:${encodeURIComponent(scope.platform)}`;
    case "chat":
      return [
        "chat",
        encodeURIComponent(scope.platform),
        encodeURIComponent(scope.scope)
      ].join(":");
    case "conversation":
      return [
        "conversation",
        encodeURIComponent(scope.platform),
        encodeURIComponent(scope.scope),
        encodeURIComponent(scope.conversationId)
      ].join(":");
  }
}

function toConversationScope(target: ConversationRef): SettingsScope {
  return {
    level: "conversation",
    platform: target.platform,
    scope: target.scope,
    conversationId: target.conversationId
  };
}

function layersForTarget(target: ConversationRef): SettingsScope[] {
  return [
    { level: "global" },
    { level: "platform", platform: target.platform },
    { level: "chat", platform: target.platform, scope: target.scope },
    toConversationScope(target)
  ];
}

function layersThrough(scope: SettingsScope): SettingsScope[] {
  switch (scope.level) {
    case "global":
      return [scope];
    case "platform":
      return [{ level: "global" }, scope];
    case "chat":
      return [
        { level: "global" },
        { level: "platform", platform: scope.platform },
        scope
      ];
    case "conversation":
      return layersForTarget(scope);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function mergeValues(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return cloneValue(overrides);
  }

  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!unsafeKeys.has(key)) {
      merged[key] = cloneValue(value);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (unsafeKeys.has(key)) {
      throw new Error(`unsafe settings key "${key}"`);
    }
    merged[key] =
      key in merged ? mergeValues(merged[key], value) : cloneValue(value);
  }
  return merged;
}

function assertSafeValue(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafeValue);
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKeys.has(key)) {
      throw new Error(`unsafe settings key "${key}"`);
    }
    assertSafeValue(child);
  }
}

function assertOverrides(
  value: unknown
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError("settings overrides must be a plain object");
  }
  assertSafeValue(value);
}

class SettingsHandle<T extends object>
  implements ScopedSettings<T>
{
  private readonly key: string;
  private readonly version: number;
  private readonly defaults: T;

  public constructor(
    private readonly store: KeyValueStore,
    private readonly definition: SettingsDefinition<T>,
    key: string
  ) {
    this.key = key;
    this.version = definition.version ?? 1;
    if (!Number.isSafeInteger(this.version) || this.version < 1) {
      throw new Error(`settings "${key}" version must be a positive integer`);
    }
    assertOverrides(definition.defaults);
    this.defaults = this.validate(cloneValue(definition.defaults));
  }

  public async get(target: ConversationRef): Promise<T> {
    return (await this.inspect(target)).value;
  }

  public async inspect(
    target: ConversationRef
  ): Promise<SettingsInspection<T>> {
    const scopes = layersForTarget(target);
    const values = await Promise.all(
      scopes.map((scope) => this.loadOverrides(scope))
    );
    const layers: SettingsInspection<T>["layers"] = {
      defaults: cloneValue(this.defaults)
    };
    const names = ["global", "platform", "chat", "conversation"] as const;
    let resolved: unknown = this.defaults;
    values.forEach((value, index) => {
      if (value !== undefined) {
        const name = names[index];
        if (name) {
          layers[name] = cloneValue(value);
        }
        resolved = mergeValues(resolved, value);
      }
    });
    return { value: this.validate(resolved), layers };
  }

  public async getOverrides(
    scope: SettingsScope
  ): Promise<DeepPartial<T> | undefined> {
    return this.loadOverrides(scope);
  }

  public async set(
    scope: SettingsScope,
    overrides: DeepPartial<T>
  ): Promise<T> {
    assertOverrides(overrides);
    const base = await this.resolveBefore(scope);
    this.validate(mergeValues(base, overrides));
    await this.store.set(this.storageKey(scope), {
      version: this.version,
      overrides: cloneValue(overrides)
    } satisfies StoredSettings);
    return this.resolveThrough(scope);
  }

  public async update(
    scope: SettingsScope,
    updater: (current: DeepPartial<T>) => DeepPartial<T>
  ): Promise<T> {
    const base = await this.resolveBefore(scope);
    await this.loadOverrides(scope);
    const key = this.storageKey(scope);
    await this.store.update<StoredSettings>(key, (stored) => {
      if (stored) {
        this.assertStored(stored);
        if (stored.version > this.version) {
          throw new Error(
            `settings "${this.key}" use newer version ${stored.version}; runtime supports ${this.version}`
          );
        }
      }
      const current = stored
        ? this.readStored(stored)
        : ({} as DeepPartial<T>);
      const next = updater(cloneValue(current));
      assertOverrides(next);
      this.validate(mergeValues(base, next));
      return {
        version: this.version,
        overrides: cloneValue(next)
      };
    });
    return this.resolveThrough(scope);
  }

  public reset(scope: SettingsScope): Promise<boolean> {
    return this.store.delete(this.storageKey(scope));
  }

  private async resolveThrough(scope: SettingsScope): Promise<T> {
    let resolved: unknown = this.defaults;
    for (const layer of layersThrough(scope)) {
      const overrides = await this.loadOverrides(layer);
      if (overrides !== undefined) {
        resolved = mergeValues(resolved, overrides);
      }
    }
    return this.validate(resolved);
  }

  private async resolveBefore(scope: SettingsScope): Promise<T> {
    let resolved: unknown = this.defaults;
    const layers = layersThrough(scope);
    for (const layer of layers.slice(0, -1)) {
      const overrides = await this.loadOverrides(layer);
      if (overrides !== undefined) {
        resolved = mergeValues(resolved, overrides);
      }
    }
    return this.validate(resolved);
  }

  private async loadOverrides(
    scope: SettingsScope
  ): Promise<DeepPartial<T> | undefined> {
    const key = this.storageKey(scope);
    const stored = await this.store.get<StoredSettings>(key);
    if (!stored) {
      return undefined;
    }
    this.assertStored(stored);
    if (stored.version > this.version) {
      throw new Error(
        `settings "${this.key}" use newer version ${stored.version}; runtime supports ${this.version}`
      );
    }
    if (stored.version === this.version) {
      return this.readStored(stored);
    }
    if (!this.definition.migrate) {
      throw new Error(
        `settings "${this.key}" require migration from version ${stored.version} to ${this.version}`
      );
    }

    let migrated: DeepPartial<T> | undefined;
    await this.store.update<StoredSettings>(key, (latest) => {
      if (!latest) {
        migrated = undefined;
        return undefined;
      }
      this.assertStored(latest);
      if (latest.version > this.version) {
        throw new Error(
          `settings "${this.key}" use newer version ${latest.version}; runtime supports ${this.version}`
        );
      }
      if (latest.version === this.version) {
        migrated = this.readStored(latest);
        return latest;
      }
      const value = this.definition.migrate?.(
        cloneValue(latest.overrides),
        latest.version
      );
      assertOverrides(value);
      migrated = value as DeepPartial<T>;
      return {
        version: this.version,
        overrides: cloneValue(value)
      };
    });
    return migrated;
  }

  private readStored(stored: StoredSettings): DeepPartial<T> {
    this.assertStored(stored);
    assertOverrides(stored.overrides);
    return cloneValue(stored.overrides) as DeepPartial<T>;
  }

  private assertStored(stored: StoredSettings): void {
    if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
      throw new Error(`settings "${this.key}" contain an invalid version`);
    }
  }

  private storageKey(scope: SettingsScope): string {
    return `@settings:${encodeURIComponent(this.key)}:${scopeKey(scope)}`;
  }

  private validate(value: unknown): T {
    const parsed = this.definition.schema
      ? this.definition.schema.parse(value)
      : value;
    assertOverrides(parsed);
    return cloneValue(parsed) as T;
  }
}

export class PluginSettingsRegistry implements SettingsRegistry {
  private readonly keys = new Set<string>();

  public constructor(private readonly store: KeyValueStore) {}

  public define<T extends object>(
    definition: SettingsDefinition<T>
  ): ScopedSettings<T> {
    const key = definition.key ?? "default";
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(key)) {
      throw new Error(
        `invalid settings key "${key}"; use lowercase letters, numbers, dot, underscore or dash`
      );
    }
    if (this.keys.has(key)) {
      throw new Error(`settings "${key}" are already defined`);
    }
    const settings = new SettingsHandle(this.store, definition, key);
    this.keys.add(key);
    return settings;
  }
}

function prefixedStore(store: KeyValueStore, prefix: string): KeyValueStore {
  return {
    get: (key) => store.get(`${prefix}:${key}`),
    set: (key, value) => store.set(`${prefix}:${key}`, value),
    delete: (key) => store.delete(`${prefix}:${key}`),
    update: (key, updater) => store.update(`${prefix}:${key}`, updater)
  };
}

export class PluginScopedStateRegistry implements ScopedStateRegistry {
  public constructor(private readonly store: KeyValueStore) {}

  public forConversation(target: ConversationRef): KeyValueStore {
    return this.forScope(toConversationScope(target));
  }

  public forScope(scope: SettingsScope): KeyValueStore {
    return prefixedStore(this.store, `@state:${scopeKey(scope)}`);
  }
}
