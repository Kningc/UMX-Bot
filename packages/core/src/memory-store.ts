import type { KeyValueStore } from "@qq-bot/plugin-sdk";

export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  public async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}
