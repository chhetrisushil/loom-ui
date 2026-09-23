import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ── The browser entry's module graph, as it is BUILT ─────────────────────────────
// `@loom-ui/hydration/client` is what a browser bundles for split hydration. It must never reach
// the server plane: the sandbox (QuickJS WASM, worker threads), the MCP plugin (an HTTP server),
// the effect runtime, a node builtin, or hydration's own server-side modules. This walks the
// `require` graph of the built `dist/client.js` — every file it can load, dependencies included —
// the same graph a bundler would follow. It needs `pnpm build` first, like every consumer does.

const DIST = resolve(__dirname, "../dist");
const BUILTINS = new Set(builtinModules);
const load = createRequire(__filename);

/** Packages whose runtime is server-only: reaching any of them pulls the server plane in. */
const FORBIDDEN_PACKAGES = new Set([
  "@loom/plugin-sandbox",
  "@loom/plugin-mcp",
  "@loom/effect-runtime",
]);

/** Hydration's own server-side modules (relative to `dist/`). */
const SERVER_FILES = new Set([
  "split/server.js",
  "provider.js",
  "controller.js",
  "invokers.js",
  "reshape.js",
  "cache.js",
  "repair.js",
]);

interface Reach {
  readonly specifier: string;
  readonly from: string;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function forbidden(specifier: string, resolved: string): boolean {
  if (specifier.startsWith("node:") || BUILTINS.has(packageName(specifier))) return true;
  if (FORBIDDEN_PACKAGES.has(packageName(specifier))) return true;
  if (/quickjs/i.test(specifier) || /quickjs/i.test(resolved)) return true;
  if (resolved.startsWith(`${DIST}/`)) return SERVER_FILES.has(relative(DIST, resolved));
  return false;
}

/** Every `require` reachable from `entry` that a browser bundle must not contain. */
function forbiddenReach(entry: string): { violations: Reach[]; files: number } {
  const seen = new Set<string>();
  const violations: Reach[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const specifier = m[1] as string;
      const from = relative(DIST, file);
      if (specifier.startsWith("node:") || BUILTINS.has(packageName(specifier))) {
        violations.push({ specifier, from });
        continue;
      }
      let target: string;
      try {
        target = load.resolve(specifier, { paths: [dirname(file)] });
      } catch {
        violations.push({ specifier: `unresolvable ${specifier}`, from });
        continue;
      }
      if (forbidden(specifier, target)) violations.push({ specifier, from });
      // Descend even past a violation: the report names everything the entry drags in.
      if (/\.[cm]?js$/.test(target)) stack.push(target);
    }
  }
  return { violations, files: seen.size };
}

describe("@loom-ui/hydration/client is browser-safe", () => {
  it("its built module graph reaches no server-only module", () => {
    const { violations, files } = forbiddenReach(resolve(DIST, "client.js"));
    expect(violations).toEqual([]);
    expect(files).toBeGreaterThan(1);
  });

  it("the walk is live: the root entry DOES reach the server plane", () => {
    // If this ever passes vacuously (the walker finds nothing anywhere), the test above means nothing.
    const { violations } = forbiddenReach(resolve(DIST, "index.js"));
    const reached = new Set(violations.map((v) => packageName(v.specifier)));
    expect(reached).toContain("@loom/plugin-sandbox");
    expect(reached).toContain("@loom/plugin-mcp");
    expect(violations.some((v) => v.specifier.startsWith("node:"))).toBe(true);
  });

  it("exports exactly the client surface", () => {
    const mod = load(resolve(DIST, "client.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([
      "DEFAULT_TIME_RANGE",
      "HYDRATION_PROJECTION_ID",
      "HYDRATION_PROJECTION_VERSION",
      "HYDRATION_SET_EVENT",
      "HydrationStore",
      "SplitHydrationController",
      "checkParams",
      "hydrationProjection",
      "isReservedHandle",
    ]);
  });

  it("the root entry still exports everything it did", () => {
    const mod = load(resolve(DIST, "index.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([
      "DEFAULT_MAX_BATCH",
      "DEFAULT_MAX_CONCURRENT_CALLS",
      "DEFAULT_TIME_RANGE",
      "HYDRATION_PROJECTION_ID",
      "HYDRATION_PROJECTION_VERSION",
      "HYDRATION_SET_EVENT",
      "HydrationCache",
      "HydrationController",
      "HydrationStore",
      "SCHEMA_REPAIRED",
      "SplitHydrationController",
      "checkParams",
      "defineReshapers",
      "executeProvider",
      "handleInventory",
      "hydrationProjection",
      "isReservedHandle",
      "jsonPathSelect",
      "limitInvoker",
      "memoInvoker",
      "outputShapeHashOf",
      "publicFinding",
      "remapOperation",
      "serveHandle",
      "serveHandles",
      "signalInvoker",
    ]);
  });

  it("bundles for the browser, small", async () => {
    const out = await build({
      entryPoints: [resolve(DIST, "client.js")],
      bundle: true,
      minify: true,
      platform: "browser",
      format: "esm",
      write: false,
      outfile: resolve(DIST, "client.bundle.js"),
      logLevel: "silent",
      metafile: true,
    });
    expect(out.errors).toEqual([]);
    const js = out.outputFiles.filter((f) => f.path.endsWith(".js"));
    expect(js).toHaveLength(1);
    expect(out.outputFiles.some((f) => f.path.endsWith(".wasm"))).toBe(false);
    // Budget: the client is a scheduler, a projection and param checks — tens of KB, not megabytes.
    const bytes = js[0]?.contents.byteLength ?? Number.POSITIVE_INFINITY;
    console.info(`@loom-ui/hydration/client browser bundle (minified, esm): ${bytes} bytes`);
    expect(bytes).toBeLessThan(64 * 1024);
  });
});
