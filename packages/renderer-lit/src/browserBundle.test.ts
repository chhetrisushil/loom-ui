import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ── The browser entry's bundle, as a bundler BUILDS it ───────────────────────────
// A page that embeds the widgets bundles `dist/index.js` (or the narrower `dist/dom/index.js`).
// It must carry no zod: zod's schemas are top-level objects a bundler cannot tree-shake, so ONE
// import of the Experience/contract schemas costs ~60 kB minified (~140 kB unminified) in every
// page. The renderer takes its value verdicts and number formatting from `@loom-ui/core/browser`
// (zod-free) instead of the main entry. Needs `pnpm build` first, like every consumer does.
//
// Measured when this budget was set (minified, esm): index 140_343 bytes, of which zod was
// 61_916 before the change (234_933 total). The budget leaves ~15% headroom for ordinary growth —
// a regression that re-imports the schemas blows through it by itself.

const DIST = resolve(__dirname, "../dist");
const CORE_DIST = realpathSync(resolve(__dirname, "../../core/dist"));
/**
 * The ONLY core modules a browser bundle may contain — an allowlist, not a denylist, so a server
 * module added to core later (one that imports zod, or anything else heavy) is caught the moment
 * the browser graph reaches it, with no list here to forget to update. These are `browser.ts` and
 * the modules it re-exports from; none imports anything at runtime (their `import type`s are
 * erased), which the zod assertion below double-checks.
 */
const CORE_BROWSER_MODULES: ReadonlySet<string> = new Set([
  "browser.js",
  "format.js",
  "kindValues.js",
  "paths.js",
]);

async function bundle(entry: string) {
  const out = await build({
    entryPoints: [resolve(DIST, entry)],
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    conditions: ["browser", "import"],
    write: false,
    logLevel: "silent",
    metafile: true,
  });
  expect(out.errors).toEqual([]);
  const inputs = Object.keys(out.metafile.inputs).map((f) => realpathSync(resolve(f)));
  return { inputs, bytes: out.outputFiles[0]?.contents.byteLength ?? Number.POSITIVE_INFINITY };
}

describe("renderer-lit's browser entries carry no zod", () => {
  for (const [entry, budget] of [
    ["index.js", 160 * 1000],
    ["dom/index.js", 160 * 1000],
  ] as const) {
    it(`${entry}: no zod, only core's allowlisted browser modules, under ${budget} bytes`, async () => {
      const { inputs, bytes } = await bundle(entry);
      console.info(`@loom-ui/renderer-lit/${entry} browser bundle (minified, esm): ${bytes} bytes`);
      expect(inputs.filter((f) => /[\\/]zod[\\/]/.test(f))).toEqual([]);
      // Every core module in the graph is on the allowlist — and nothing else of core's is.
      const coreInGraph = inputs
        .filter((f) => f.startsWith(`${CORE_DIST}/`))
        .map((f) => relative(CORE_DIST, f))
        .sort();
      expect(coreInGraph.filter((m) => !CORE_BROWSER_MODULES.has(m))).toEqual([]);
      // It does take core's zod-free browser modules — a bundle with none would be vacuous.
      expect(inputs.some((f) => f === resolve(CORE_DIST, "browser.js"))).toBe(true);
      expect(bytes).toBeLessThan(budget);
    });
  }
});
