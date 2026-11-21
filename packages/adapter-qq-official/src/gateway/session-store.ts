import type { KeyValueStore } from "@qq-bot/plugin-sdk";
import type { PersistedGatewayState } from "../protocol.js";

export interface QqGatewaySession {
  sessionId: string;
  processedSequence: number;
}

/**
 * Persists the Gateway session id and the committed event sequence.
 *
 * Without this a process restart cannot Resume and has to Identify, which
 * replays from the start of the server's buffer. Only a *contiguous* run of
 * finished events may be committed, so the caller decides what to pass here —
 * this type is only responsible for storage and validation.
 */
export class QqGatewaySessionStore {
  private readonly key: string;

  public constructor(
    appId: string,
    private readonly store: KeyValueStore | undefined,
    shard = 0
  ) {
    this.key = ["adapter", "qq-official", appId, "gateway", String(shard)].join(
      ":"
    );
  }

  public get storeKey(): string {
    return this.key;
  }

  /** Returns the stored session, or undefined when it is absent or unusable. */
  public async restore(): Promise<QqGatewaySession | undefined> {
    const state = await this.store?.get<PersistedGatewayState>(this.key);
    if (
      !state?.sessionId ||
      !Number.isSafeInteger(state.processedSequence) ||
      state.processedSequence < 0
    ) {
      return undefined;
    }
    return {
      sessionId: state.sessionId,
      processedSequence: state.processedSequence
    };
  }

  public async commit(
    sessionId: string | undefined,
    processedSequence: number
  ): Promise<void> {
    if (!this.store || !sessionId) {
      return;
    }
    await this.store.set<PersistedGatewayState>(this.key, {
      sessionId,
      processedSequence
    });
  }

  public async clear(): Promise<void> {
    await this.store?.delete(this.key);
  }
}
