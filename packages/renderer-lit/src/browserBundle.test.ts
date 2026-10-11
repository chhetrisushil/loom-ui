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
  "action.js",
  "browser.js",
  // U8: only what a chat WIDGET needs. `chat.js`, `chatFeed.js` and `chatHost.js` (the fold over loom's
  // API, host-side acceptance, the catalogue guard) are deliberately absent: the entry that imports one
  // of them fails this test.
  "chatActions.js",
  "chatForm.js",
  "chatText.js",
  "chatUi.js",
  "chatValue.js",
  "chatWords.js",
  "containerRoles.js",
  "format.js",
  "kindValues.js",
  "media.js",
  "mediaRef.js",
  "mediaText.js",
  "messages.js",
  "paths.js",
  // LU-2: the zod-free provider-graph checks ride `core/browser` for a client-side presubmit preview.
  "providerGraph.js",
  "streamText.js",
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
    // U9 raised these from 160 kB by 4 kB (index measured 157_537 -> 162_143): the MediaRef value
    // contract (~3 kB) has to ride in `checkKindValue` for every page, because a media widget's
    // value is checked wherever a value is checked. The widgets themselves are NOT here: they are the
    // opt-in `media.js` entry below.
    // U8 raised these from 164 kB by 8 kB (index measured 162_143 -> 168_584): the ChatValue contract
    // (~6.4 kB) rides in `checkKindValue` for every page, as the MediaRef contract does. The chat widgets
    // themselves are NOT here: they are the opt-in `chat.js` entry below.
    // U14 raised every budget by 8 kB (containers 9 kB, whose graph is the smallest): the fixed-words
    // catalogue (`messages.js`, ~7 kB: every English string once, under its key) rides with the renderer.
    // U17 raised index by 6 kB (measured 175_259 -> 180_313): windowed rendering (`virtual.ts`, shared by lu-table,
    // lu-data-table and lu-chat), update coalescing and visibility reporting. `dom/index.js` stays under 180 kB (105_315).
    ["index.js", 186 * 1000],
    ["dom/index.js", 180 * 1000],
    // The opt-in reference containers (tabs, stepper): their own entry (the size is mostly the shared registry/i18n it imports), so a page that draws
    // plain containers does not pay for chrome it never registers.
    // U8 fix round 1: 80 -> 81 kB (the contract grew by `mode`: +130 bytes put it 26 over).
    // LOOM_REF bump to a8e69f5b: 90 -> 91 kB (measured 90_366, 366 over). Its graph is the shared registry/i18n/virtual
    // code the U16/U17/#71 slices grew, which this smallest entry carries in full; index and dom/index stay under budget.
    // LU-2: 91 -> 94 kB (measured 93_006): `core/browser` now re-exports the zod-free `providerGraphFindings`
    // (~2.6 kB) for a client-side presubmit preview, and this smallest entry takes the barrel in full.
    ["dom/containers.js", 94 * 1000],
    // U9: the opt-in media widgets (resolver-driven elements + the upload control) and the default
    // registry they extend. Its own entry, so index/dom do not grow for a page with no media.
    ["media.js", 187 * 1000],
    // U8: the opt-in chat widgets (transcript, text / form / select inputs) and the default registry they extend.
    ["chat.js", 203 * 1000],
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

// U11: the opt-in signal observer (an IntersectionObserver and two listeners) is its own entry, so
// index/dom pay nothing, and it imports NOTHING from core at runtime (it takes the collector by its
// shape), so it is not subject to the core allowlist above — it must have no core module at all.
describe("renderer-lit/signals", () => {
  it("bundles with no zod and no core module, under 6000 bytes", async () => {
    const { inputs, bytes } = await bundle("signals.js");
    console.info(`@loom-ui/renderer-lit/signals.js browser bundle (minified, esm): ${bytes} bytes`);
    expect(inputs.filter((f) => /[\\/]zod[\\/]/.test(f))).toEqual([]);
    expect(inputs.filter((f) => f.startsWith(`${CORE_DIST}/`))).toEqual([]);
    expect(bytes).toBeLessThan(6 * 1000);
  });
});
