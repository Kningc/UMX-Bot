import { describe, expect, it } from "vitest";
import { BotNavigationRegistry } from "./navigation-registry.js";

function plugin(name: string, order = 0) {
  return {
    name,
    title: name,
    order,
    listed: true
  };
}

describe("BotNavigationRegistry", () => {
  it("collects sorted plugin pages and unregisters them", () => {
    const registry = new BotNavigationRegistry();
    registry.forPlugin(plugin("second")).register({
      title: "Second",
      order: 20,
      items: [{ label: "Later", command: "later", order: 20 }]
    });
    const dispose = registry.forPlugin(plugin("first")).register({
      title: "First",
      order: 10,
      items: [
        {
          id: "now",
          label: "Now",
          command: "now",
          featured: true,
          scopes: ["group"]
        }
      ]
    });

    expect(registry.list()).toMatchObject([
      {
        id: "first",
        plugin: { name: "first" },
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
        plugin: { name: "second" },
        title: "Second"
      }
    ]);

    dispose();
    expect(registry.list().map((page) => page.id)).toEqual(["second"]);
  });

  it("rejects invalid and duplicate registrations", () => {
    const registry = new BotNavigationRegistry();
    const sample = registry.forPlugin(plugin("sample"));
    sample.register({
      title: "Sample",
      items: [{ label: "Run", command: "run" }]
    });

    expect(() =>
      sample.register({
        title: "Again",
        items: [{ label: "Again", command: "again" }]
      })
    ).toThrow('navigation page "sample" is already registered');
    expect(() =>
      registry.forPlugin(plugin("bad")).register({
        title: "Bad",
        items: [{ label: "Bad", command: "/prefixed" }]
      })
    ).toThrow("without a prefix");
  });

  it("formats navigation commands with the configured prefix", () => {
    const registry = new BotNavigationRegistry("!");
    registry.forPlugin(plugin("tools")).register({
      items: [{ label: "Inspect", command: "inspect", args: "status" }]
    });

    expect(registry.list()[0]?.items[0]).toMatchObject({
      commandName: "inspect",
      command: "!inspect status"
    });
  });
});
