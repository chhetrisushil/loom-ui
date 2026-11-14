import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Every public package's npm publish metadata (version, files allowlist, publishConfig, real
// `@loom/*` ranges, `workspace:^`) is written by scripts/publish-metadata.mjs. This guard re-runs
// it in `--check` mode so a hand edit, a new package or a new `@loom/*` dependency that skipped the
// generator fails here instead of shipping a manifest that cannot install.
const ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/publish-metadata.mjs");

function check(root: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--check", "--root", root], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

/** A throwaway tree with one package copied from this repo, so the faults below have a target. */
function fixture(mutate: (pkg: Record<string, unknown>) => void, extra?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "lu-publish-"));
  const dir = join(root, "packages/core");
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "packages/core/package.json"), join(dir, "package.json"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  mutate(pkg);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  if (extra) {
    mkdirSync(join(root, "packages/internal"));
    writeFileSync(join(root, "packages/internal/package.json"), JSON.stringify(extra));
  }
  return root;
}

describe("npm publish metadata", () => {
  it("is current for every public package", () => {
    const r = check(ROOT);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails on a `*` @loom range (non-vacuity)", () => {
    const root = fixture((pkg) => {
      (pkg.dependencies as Record<string, string>)["@loom/core"] = "*";
    });
    try {
      const r = check(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("packages/core: publish metadata is stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a public package that depends on a private one", () => {
    const root = fixture(
      (pkg) => {
        (pkg.dependencies as Record<string, string>)["@loom-ui/internal"] = "workspace:^";
      },
      { name: "@loom-ui/internal", private: true }
    );
    try {
      const r = check(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("depends on private @loom-ui/internal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
