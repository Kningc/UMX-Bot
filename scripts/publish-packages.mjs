#!/usr/bin/env node
// Publishes every public workspace package whose current version is not on
// npm yet.
//
// `pnpm pack` builds each tarball (it rewrites `workspace:` ranges to real
// versions) and the npm CLI uploads it. Publishing through npm rather than
// `pnpm publish` is what makes npm Trusted Publishing (OIDC) work in CI: npm
// exchanges the GitHub Actions identity token for a short-lived publish
// credential, so no NPM_TOKEN is stored anywhere, and provenance is attached
// automatically.
//
// Run it locally (after `npm login`) for the very first publish, which npm
// requires before a Trusted Publisher can be configured on a package.
//
// In GitHub Actions it also creates and pushes a `<name>@<version>` git tag
// per published package and prints the "New tag:" lines changesets/action
// reads to create GitHub releases.
//
// Usage: node scripts/publish-packages.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dryRun = process.argv.includes("--dry-run");
const inCi = process.env.GITHUB_ACTIONS === "true";

const changesetConfig = JSON.parse(
  readFileSync(join(root, ".changeset/config.json"), "utf8")
);
const ignored = new Set(changesetConfig.ignore ?? []);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  });
}

function workspacePackages() {
  const list = JSON.parse(run("pnpm", ["-r", "ls", "--depth", "-1", "--json"]));
  return list
    .filter((entry) => entry.path !== root.replace(/\/$/u, ""))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(entry.path, "package.json"), "utf8")
      );
      return { dir: entry.path, manifest };
    })
    .filter(({ manifest }) => !manifest.private && !ignored.has(manifest.name));
}

function isPublished(name, version) {
  try {
    const found = run("npm", ["view", `${name}@${version}`, "version"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    return found.trim() === version;
  } catch {
    // E404: the package or this version does not exist yet.
    return false;
  }
}

const packages = workspacePackages();
if (packages.length === 0) {
  console.log("No publishable packages.");
  process.exit(0);
}

const pending = packages.filter(
  ({ manifest }) => !isPublished(manifest.name, manifest.version)
);
for (const { manifest } of packages) {
  if (!pending.some((p) => p.manifest.name === manifest.name)) {
    console.log(`${manifest.name}@${manifest.version} is already on npm`);
  }
}
if (pending.length === 0) {
  process.exit(0);
}

// Tag each package as soon as it is on npm. Tagging only after the loop
// would leave the packages published before a failure untagged for good: the
// next run sees them on npm and skips them.
function tagPublished(id) {
  if (dryRun || !inCi) {
    return;
  }
  run("git", ["tag", id]);
  run("git", ["push", "origin", `refs/tags/${id}`], {
    stdio: ["ignore", "ignore", "inherit"]
  });
  console.log(`New tag: ${id}`);
}

const outDir = mkdtempSync(join(tmpdir(), "umx-bot-publish-"));
try {
  for (const { dir, manifest } of pending) {
    const id = `${manifest.name}@${manifest.version}`;
    run("pnpm", ["pack", "--pack-destination", outDir], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"]
    });
    // pnpm names it like npm: "@scope/name" -> "scope-name-<version>.tgz".
    const expected = `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${manifest.version}.tgz`;
    const tarball = readdirSync(outDir).find((file) => file === expected);
    if (!tarball) {
      throw new Error(`pnpm pack produced no tarball for ${id}`);
    }
    const args = ["publish", join(outDir, tarball), "--access", "public"];
    if (dryRun) {
      args.push("--dry-run");
    }
    console.log(`Publishing ${id}${dryRun ? " (dry run)" : ""}`);
    execFileSync("npm", args, { cwd: root, stdio: "inherit" });
    tagPublished(id);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
