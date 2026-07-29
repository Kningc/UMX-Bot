import type { PluginDependency } from "@qq-bot/plugin-sdk";
import { satisfies, valid, validRange } from "semver";

export interface NormalizedPluginDependency {
  name: string;
  version: string;
  optional: boolean;
}

export function assertPluginVersion(version: string, subject: string): void {
  if (valid(version) === null) {
    throw new Error(
      `${subject} must use a valid semantic version, got "${version}"`
    );
  }
}

export function normalizePluginDependency(
  dependency: PluginDependency,
  subject: string
): NormalizedPluginDependency {
  const normalized =
    typeof dependency === "string"
      ? { name: dependency, version: "*", optional: false }
      : {
          name: dependency.name,
          version: dependency.version ?? "*",
          optional: dependency.optional ?? false
        };
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized.name)) {
    throw new Error(
      `${subject} contains invalid dependency "${normalized.name}"`
    );
  }
  assertVersionRange(normalized.version, subject);
  return normalized;
}

export function satisfiesPluginVersion(
  version: string,
  range: string
): boolean {
  assertPluginVersion(version, "plugin version");
  assertVersionRange(range, "plugin dependency");
  return satisfies(version, range);
}

function assertVersionRange(range: string, subject: string): void {
  if (
    range !== range.trim() ||
    range.length === 0 ||
    validRange(range) === null
  ) {
    throw new Error(
      `${subject} contains invalid version range "${range}"`
    );
  }
}
