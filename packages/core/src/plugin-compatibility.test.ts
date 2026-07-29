import { describe, expect, it } from "vitest";
import {
  assertPluginVersion,
  normalizePluginDependency,
  satisfiesPluginVersion
} from "./plugin-compatibility.js";

describe("plugin compatibility", () => {
  it("supports exact, caret, tilde and comparator ranges", () => {
    expect(satisfiesPluginVersion("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfiesPluginVersion("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesPluginVersion("0.2.9", "^0.2.1")).toBe(true);
    expect(satisfiesPluginVersion("0.3.0", "^0.2.1")).toBe(false);
    expect(satisfiesPluginVersion("1.2.8", "~1.2.0")).toBe(true);
    expect(satisfiesPluginVersion("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesPluginVersion("1.5.0", ">=1.2.0 <2.0.0")).toBe(true);
  });

  it("compares prerelease versions according to SemVer precedence", () => {
    expect(satisfiesPluginVersion("1.0.0-beta.2", ">=1.0.0-beta.1")).toBe(true);
    expect(satisfiesPluginVersion("1.0.0-beta.1", ">=1.0.0")).toBe(false);
  });

  it("validates plugin versions and dependency descriptors", () => {
    expect(() => assertPluginVersion("1.0", "plugin")).toThrow(
      "valid semantic version"
    );
    expect(() => assertPluginVersion("1.0.0-beta.01", "plugin")).toThrow(
      "leading zero"
    );
    expect(
      normalizePluginDependency(
        { name: "provider", version: "^2.0.0", optional: true },
        "consumer"
      )
    ).toEqual({
      name: "provider",
      version: "^2.0.0",
      optional: true
    });
    expect(() =>
      normalizePluginDependency(
        { name: "provider", version: "latest" },
        "consumer"
      )
    ).toThrow("valid semantic version");
  });
});
