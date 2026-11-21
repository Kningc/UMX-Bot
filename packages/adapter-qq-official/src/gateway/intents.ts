import { GROUP_AND_C2C_EVENT, INTERACTION_EVENT } from "../protocol.js";

export interface ResolveIntentsOptions {
  /**
   * Explicit numeric override. Only set this when the exact Intent grants for
   * this bot are known: asking for an Intent the bot was not granted makes the
   * Gateway reject authentication outright.
   */
  intents?: number | undefined;
  enableInteractions?: boolean | undefined;
}

/**
 * Builds the Intent bitmask for the Identify payload.
 *
 * The adapter must never hard-code the full set: Intents are granted per bot
 * on the open platform, so the default is the minimum this adapter actually
 * uses, and anything extra has to be opted into.
 */
export function resolveIntents(options: ResolveIntentsOptions): number {
  if (options.intents !== undefined) {
    if (!Number.isSafeInteger(options.intents) || options.intents < 0) {
      throw new Error("intents must be a non-negative integer");
    }
    return options.intents;
  }
  return (
    GROUP_AND_C2C_EVENT | (options.enableInteractions ? INTERACTION_EVENT : 0)
  );
}

export function describeIntents(intents: number): string[] {
  const names: string[] = [];
  if ((intents & GROUP_AND_C2C_EVENT) !== 0) {
    names.push("GROUP_AND_C2C_EVENT");
  }
  if ((intents & INTERACTION_EVENT) !== 0) {
    names.push("INTERACTION");
  }
  const known = GROUP_AND_C2C_EVENT | INTERACTION_EVENT;
  if ((intents & ~known) !== 0) {
    names.push(`OTHER(0x${(intents & ~known).toString(16)})`);
  }
  return names;
}
