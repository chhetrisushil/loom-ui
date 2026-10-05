import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Client-side packages must not reach the server hydration plane ───────────────
// The root entry `@loom-ui/hydration` imports the sandbox (QuickJS WASM) and the MCP plugin; a
// package that only needs a pure helper or a constant uses `@loom-ui/hydration/client`. Package
// roles: `core` (compiler, no runtime deps on hydration), `planner` (authors/validates plans, no
// execution), `renderer-terminal` and `renderer-lit` (render published state). None executes a
// provider, so none may reach the server plane — by source import or by its built module graph.
// (`hydration` itself, and the host that wires `HydrationController`, are the server side.)

const PACKAGES = resolve(__dirname, "../..");
const CLIENT_PACKAGES = ["core", "planner", "renderer-terminal", "renderer-lit"] as const;
const HYDRATION_DIST = resolve(PACKAGES, "hydration/dist");

const FORBIDDEN_PACKAGES = new Set([
  "@loom/plugin-sandbox",
  "@loom/plugin-mcp",
  "@loom/effect-runtime",
  "@loom/agent",
]);
const SERVER_FILES = new Set(
  [
    "index.js",
    "split/server.js",
    "provider.js",
    "dataProvider.js",
    "loomEffectProvider.js",
    "controller.js",
    "invokers.js",
    "reshape.js",
    "cache.js",
    "repair.js",
  ].map((f) => resolve(HYDRATION_DIST, f))
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test(-support)?\.tsx?$/.test(name) ? [p] : [];
  });
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

describe("client-side packages stay off the server hydration entry", () => {
  for (const pkg of CLIENT_PACKAGES) {
    it(`${pkg}: no source file imports the root hydration entry or a server-only package`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(join(PACKAGES, pkg, "src"))) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
          const spec = m[1] as string;
          if (spec === "@loom-ui/hydration" || FORBIDDEN_PACKAGES.has(packageName(spec))) {
            offenders.push(`${file.slice(PACKAGES.length + 1)} imports "${spec}"`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${pkg}: its built module graph reaches no server plane (needs pnpm build)`, () => {
      const entry = resolve(PACKAGES, pkg, "dist/index.js");
      expect(existsSync(entry)).toBe(true);
      const seen = new Set<string>();
      const violations = new Set<string>();
      const stack = [entry];
      while (stack.length > 0) {
        const file = stack.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
          const spec = m[1] as string;
          if (spec.startsWith("node:")) continue;
          let target: string;
          try {
            target = createRequire(file).resolve(spec);
          } catch {
            continue; // an optional/unresolvable edge cannot be bundled either
          }
          if (
            FORBIDDEN_PACKAGES.has(packageName(spec)) ||
            /quickjs/i.test(spec) ||
            /quickjs/i.test(target) ||
            SERVER_FILES.has(target)
          ) {
            violations.add(`${file.slice(PACKAGES.length + 1)} -> ${spec}`);
          }
          if (/\.[cm]?js$/.test(target)) stack.push(target);
        }
      }
      expect([...violations]).toEqual([]);
      expect(seen.size).toBeGreaterThan(0);
    });
  }

  it("the walk is live: the built root hydration entry IS flagged", () => {
    expect(SERVER_FILES.has(resolve(HYDRATION_DIST, "index.js"))).toBe(true);
    expect(dirname(resolve(HYDRATION_DIST, "index.js"))).toBe(HYDRATION_DIST);
  });
});
