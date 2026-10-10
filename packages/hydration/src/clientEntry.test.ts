import { existsSync, readFileSync, realpathSync } from "node:fs";
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
//
// Two walks, because neither sees everything:
// - `forbiddenReach` (regex over `require("…")`, resolved with Node's `require` conditions) sees
//   CommonJS only: no ESM `import`, no dynamic `import()`, and a dependency whose
//   `exports` map sends the `browser`/`import` condition somewhere else is resolved to its
//   `require` target.
// - The esbuild case bundles `dist/client.js` the way a browser bundler does — ESM and dynamic
//   `import()` included, resolved under the `browser` and `import` conditions — and checks every
//   input it pulled in against the same forbidden set.

const DIST = resolve(__dirname, "../dist");
const BUILTINS = new Set(builtinModules);
const load = createRequire(__filename);

/** Packages whose runtime is server-only: reaching any of them pulls the server plane in. */
const FORBIDDEN_PACKAGES = new Set([
  "@loom/plugin-sandbox",
  "@loom/plugin-mcp",
  "@loom/effect-runtime",
  // U3 — `effectPin` needs `toolInputJsonSchema` from `@loom/agent` (llm, reasoning, workflow-runtime…):
  // server-only, never in the client graph.
  "@loom/agent",
  // U6 — the lineage runtime is an event log + content store: server-side, never in a client graph.
  "@loom-ui/lineage",
  // U11 — reward ingestion/settlement is host-side (recordOutcome, the event log); a client only SENDS signals.
  "@loom-ui/learning",
  // U7 — change delivery reads the lineage and content stores: server-side, never in a client graph.
  "@loom-ui/changes",
]);

/** Hydration's own server-side modules (relative to `dist/`). */
const SERVER_FILES = new Set([
  "split/server.js",
  "provider.js",
  "dataProvider.js",
  "loomEffectProvider.js",
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

/** The real directories of the forbidden packages, as a bundler sees them (links resolved). */
/** Forbidden names that are not dependencies of hydration — refused BY NAME only (no directory). */
const NOT_A_HYDRATION_DEP = new Set(["@loom-ui/lineage", "@loom-ui/changes", "@loom-ui/learning"]);
const FORBIDDEN_DIRS = [...FORBIDDEN_PACKAGES].flatMap((name) => {
  if (NOT_A_HYDRATION_DEP.has(name)) return [];
  // Any other forbidden name MUST resolve: a typo or a removed dependency fails here, loudly,
  // instead of silently dropping its bundler-input directory check.
  return [realpathSync(resolve(__dirname, "../node_modules", name))];
});

describe("@loom-ui/hydration/client is browser-safe", () => {
  it("dist carries no stale split.js to shadow split/index.js", () => {
    // `split.ts` became `split/`; a dist built before that still holds `split.js`, which Node
    // resolves for "./split" ahead of `split/index.js`. `build` removes it; this checks it did.
    expect(existsSync(resolve(DIST, "split.js"))).toBe(false);
    expect(load.resolve(resolve(DIST, "split"))).toBe(resolve(DIST, "split/index.js"));
  });

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
      "HYDRATION_VALUES_PREFIX",
      "HydrationStore",
      "SplitHydrationController",
      "checkParams",
      "connectConversation",
      "handleOfPath",
      "hydrationProjection",
      "isReservedHandle",
      "jsonPathSelect",
      "outputShapeHashOf",
      "publishChat",
      "stepReferences",
      "terminalSteps",
      "topoWaves",
    ]);
  });

  it("the root entry still exports everything it did", () => {
    const mod = load(resolve(DIST, "index.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([
      "ContentRefConfigError",
      "DEFAULT_CACHE_MAX_ENTRIES",
      "DEFAULT_DATA_PROVIDERS",
      "DEFAULT_MAX_BATCH",
      "DEFAULT_MAX_CONCURRENT_CALLS",
      "DEFAULT_TIME_RANGE",
      "HYDRATION_PROJECTION_ID",
      "HYDRATION_PROJECTION_VERSION",
      "HYDRATION_SET_EVENT",
      "HydrationCache",
      "HydrationController",
      "HydrationStore",
      "LOOM_EFFECT_KIND",
      "SCHEMA_REPAIRED",
      "SplitHydrationController",
      "TARGET_FAILED",
      "TARGET_UNREGISTERED",
      "checkDataProviderConformance",
      "checkParams",
      "connectConversation",
      "createServeSurface",
      "defineDataProviders",
      "defineReshapers",
      "effectPin",
      "executeProvider",
      "handleInventory",
      "hydrationProjection",
      "isReservedHandle",
      "jsonPathSelect",
      "limitInvoker",
      "loomEffectProvider",
      "mcpProvider",
      "memoInvoker",
      "outputShapeHashOf",
      "publicFinding",
      "publishChat",
      "remapOperation",
      "serveHandle",
      "serveHandles",
      "signalInvoker",
      "stepReferences",
      "terminalSteps",
      "topoWaves",
    ]);
  });

  it("path.js reaches nothing at runtime: no core, no other module", () => {
    // `@loom-ui/core` is CommonJS; a client that needs `handleOfPath` must not drag it in.
    const src = readFileSync(resolve(DIST, "path.js"), "utf8");
    expect([...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)]).toEqual([]);
  });

  it("bundles for the browser, small", async () => {
    const out = await build({
      entryPoints: [resolve(DIST, "client.js")],
      bundle: true,
      minify: true,
      platform: "browser",
      format: "esm",
      // Explicit, though they are `platform: "browser"`'s defaults: resolve as a browser would.
      conditions: ["browser", "import"],
      write: false,
      logLevel: "silent",
      metafile: true,
    });
    expect(out.errors).toEqual([]);
    // Every input the bundler pulled in, resolved under the browser/import conditions.
    const inputs = Object.keys(out.metafile.inputs).map((f) => realpathSync(resolve(f)));
    const pulled = inputs.filter(
      (f) =>
        /quickjs/i.test(f) ||
        FORBIDDEN_DIRS.some((d) => f.startsWith(`${d}/`)) ||
        (f.startsWith(`${DIST}/`) && SERVER_FILES.has(relative(DIST, f)))
    );
    expect(pulled).toEqual([]);
    expect(inputs.length).toBeGreaterThan(1);
    expect(out.outputFiles).toHaveLength(1);
    // Budget: the client is a scheduler, a projection and param checks — tens of KB, not megabytes.
    const bytes = out.outputFiles[0]?.contents.byteLength ?? Number.POSITIVE_INFINITY;
    console.info(`@loom-ui/hydration/client browser bundle (minified, esm): ${bytes} bytes`);
    // 64 -> 72 KiB for U8: the ChatValue contract (~6 kB) rides in `checkKindValue` exactly as the
    // MediaRef contract does, plus the ~2 kB conversation connection.
    // 72 -> 74 KiB for loom 2704704 (#556): `@loom/core`'s `schedule$` gained the DST sub-hourly
    // warning (~0.8 kB minified). The client takes the whole core barrel (CJS, not tree-shaken).
    expect(bytes).toBeLessThan(74 * 1024);
  });
});
