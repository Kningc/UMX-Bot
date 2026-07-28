import type {
  Dispose,
  ServiceRegistry,
  ServiceToken
} from "@qq-bot/plugin-sdk";

interface ServiceEntry {
  owner: string;
  value: unknown;
  tokenName: string;
}

export class ServiceContainer {
  private readonly services = new Map<symbol, ServiceEntry>();

  public forPlugin(plugin: string): ServiceRegistry {
    return {
      provide: (token, service) => this.provide(plugin, token, service),
      get: (token) => this.get(token),
      has: (token) => this.services.has(token.id)
    };
  }

  private provide<T>(
    plugin: string,
    token: ServiceToken<T>,
    service: T
  ): Dispose {
    const existing = this.services.get(token.id);
    if (existing) {
      throw new Error(
        `service "${token.name}" is already provided by plugin "${existing.owner}"`
      );
    }

    const entry: ServiceEntry = {
      owner: plugin,
      value: service,
      tokenName: token.name
    };
    this.services.set(token.id, entry);

    return () => {
      if (this.services.get(token.id) === entry) {
        this.services.delete(token.id);
      }
    };
  }

  private get<T>(token: ServiceToken<T>): T {
    const entry = this.services.get(token.id);
    if (!entry) {
      throw new Error(`service "${token.name}" is not available`);
    }
    return entry.value as T;
  }
}
