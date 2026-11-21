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
 *
 * The session is stored together with the intents it was identified with. QQ
 * keeps those intents for the whole session, so Resuming after the configured
 * intents changed (for example enabling interactions) would silently keep the
 * old subscription. A stored session whose intents differ, or that predates
 * intent tracking, is therefore discarded and the client Identifies afresh;
 * persistent message de-duplication absorbs the replay that follows.
 */
export class QqGatewaySessionStore {
  private readonly key: string;
  private discarded:
    | { stored: number | undefined; current: number }
    | undefined;

  public constructor(
    appId: string,
    private readonly store: KeyValueStore | undefined,
    private readonly intents: number,
    shard = 0
  ) {
    this.key = ["adapter", "qq-official", appId, "gateway", String(shard)].join(
      ":"
    );
  }

  public get storeKey(): string {
    return this.key;
  }

  /** Set when the last `restore()` dropped a session over an intents mismatch. */
  public get discardedForIntents():
    | { stored: number | undefined; current: number }
    | undefined {
    return this.discarded;
  }

  /** Returns the stored session, or undefined when it is absent or unusable. */
  public async restore(): Promise<QqGatewaySession | undefined> {
    this.discarded = undefined;
    const state = await this.store?.get<PersistedGatewayState>(this.key);
    if (
      !state?.sessionId ||
      !Number.isSafeInteger(state.processedSequence) ||
      state.processedSequence < 0
    ) {
      return undefined;
    }
    if (state.intents !== this.intents) {
      this.discarded = { stored: state.intents, current: this.intents };
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
      processedSequence,
      intents: this.intents
    });
  }

  public async clear(): Promise<void> {
    await this.store?.delete(this.key);
  }
}
