import type { PluginDependency } from "@qq-bot/plugin-sdk";

export interface NormalizedPluginDependency {
  name: string;
  version: string;
  optional: boolean;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function assertPluginVersion(version: string, subject: string): void {
  parseSemVer(version, subject);
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
    throw new Error(`${subject} contains invalid dependency "${normalized.name}"`);
  }
  assertVersionRange(normalized.version, subject);
  return normalized;
}

export function satisfiesPluginVersion(
  version: string,
  range: string
): boolean {
  const candidate = parseSemVer(version, "plugin version");
  if (range === "*") {
    return true;
  }
  return range
    .trim()
    .split(/\s+/u)
    .every((comparator) => satisfiesComparator(candidate, comparator));
}

function assertVersionRange(range: string, subject: string): void {
  if (range !== range.trim() || range.length === 0) {
    throw new Error(`${subject} contains invalid version range "${range}"`);
  }
  if (range === "*") {
    return;
  }
  for (const comparator of range.split(/\s+/u)) {
    parseComparator(comparator, subject);
  }
}

function satisfiesComparator(candidate: SemVer, comparator: string): boolean {
  const parsed = parseComparator(comparator, "plugin dependency");
  const comparison = compareSemVer(candidate, parsed.version);
  switch (parsed.operator) {
    case "=":
      return comparison === 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "^":
      return (
        comparison >= 0 &&
        compareSemVer(candidate, caretUpperBound(parsed.version)) < 0
      );
    case "~":
      return (
        comparison >= 0 &&
        compareSemVer(candidate, {
          major: parsed.version.major,
          minor: parsed.version.minor + 1,
          patch: 0,
          prerelease: []
        }) < 0
      );
  }
}

function parseComparator(
  comparator: string,
  subject: string
): {
  operator: "=" | ">" | ">=" | "<" | "<=" | "^" | "~";
  version: SemVer;
} {
  const matched = /^(>=|<=|>|<|\^|~|=)?(.+)$/u.exec(comparator);
  if (!matched?.[2]) {
    throw new Error(`${subject} contains invalid version range comparator`);
  }
  return {
    operator:
      (matched[1] as ">" | ">=" | "<" | "<=" | "^" | "~" | undefined) ?? "=",
    version: parseSemVer(matched[2], subject)
  };
}

function parseSemVer(version: string, subject: string): SemVer {
  const matched = versionPattern.exec(version);
  if (!matched) {
    throw new Error(`${subject} must use a valid semantic version, got "${version}"`);
  }
  const core = [matched[1], matched[2], matched[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`${subject} semantic version is outside the safe integer range`);
  }
  const prerelease = matched[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier)
    )
  ) {
    throw new Error(
      `${subject} semantic version has a numeric prerelease identifier with a leading zero`
    );
  }
  return {
    major: core[0]!,
    minor: core[1]!,
    patch: core[2]!,
    prerelease
  };
}

function caretUpperBound(version: SemVer): SemVer {
  if (version.major > 0) {
    return {
      major: version.major + 1,
      minor: 0,
      patch: 0,
      prerelease: []
    };
  }
  if (version.minor > 0) {
    return {
      major: 0,
      minor: version.minor + 1,
      patch: 0,
      prerelease: []
    };
  }
  return {
    major: 0,
    minor: 0,
    patch: version.patch + 1,
    prerelease: []
  };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) {
      continue;
    }
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) {
        return leftPart.length < rightPart.length ? -1 : 1;
      }
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
