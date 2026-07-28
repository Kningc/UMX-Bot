import { describe, expect, it } from "vitest";
import { BotNavigationRegistry } from "./navigation-registry.js";

describe("BotNavigationRegistry", () => {
  it("collects sorted plugin pages and unregisters them", () => {
    const registry = new BotNavigationRegistry();
    registry.forPlugin("second").register({
      title: "Second",
      order: 20,
      items: [{ label: "Later", command: "/later", order: 20 }]
    });
    const dispose = registry.forPlugin("first").register({
      title: "First",
      order: 10,
      items: [
        {
          id: "now",
          label: "Now",
          command: "/now",
          featured: true,
          scopes: ["group"]
        }
      ]
    });

    expect(registry.list()).toMatchObject([
      {
        id: "first",
        plugin: "first",
        title: "First",
        items: [
          {
            id: "now",
            command: "/now",
            featured: true,
            scopes: ["group"]
          }
        ]
      },
      {
        id: "second",
        plugin: "second",
        title: "Second"
      }
    ]);

    dispose();
    expect(registry.list().map((page) => page.id)).toEqual(["second"]);
  });

  it("rejects invalid and duplicate registrations", () => {
    const registry = new BotNavigationRegistry();
    const plugin = registry.forPlugin("sample");
    plugin.register({
      title: "Sample",
      items: [{ label: "Run", command: "/run" }]
    });

    expect(() =>
      plugin.register({
        title: "Again",
        items: [{ label: "Again", command: "/again" }]
      })
    ).toThrow('navigation page "sample" is already registered');
    expect(() =>
      registry.forPlugin("bad").register({
        title: "Bad",
        items: [{ label: "Bad", command: "missing-prefix" }]
      })
    ).toThrow('must start with "/"');
  });
});
