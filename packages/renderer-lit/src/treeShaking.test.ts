import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ── U20: importing ONE widget does not pull the others ───────────────────────────
// Registration used to be a side effect of importing any widget barrel, so a host that wanted
// `<lu-kpi>` bundled every element. Now each widget CLASS module is pure, registration lives in
// `dist/elements/<module>.js` (one per module) and `dist/register.js` (all), and package.json's
// `sideEffects` names exactly those. Needs `pnpm build` first, like browserBundle.test.ts.

const DIST = realpathSync(resolve(__dirname, "../dist"));
const PKG = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
  sideEffects: string[];
  exports: Record<string, unknown>;
};

async function widgetsIn(entry: string): Promise<{ modules: string[]; bytes: number }> {
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
  const modules = Object.keys(out.metafile.inputs)
    .map((f) => realpathSync(resolve(f)))
    .filter((f) => f.startsWith(`${DIST}/widgets/`))
    .map((f) => basename(f, ".js"))
    .sort();
  return { modules, bytes: out.outputFiles[0]?.contents.byteLength ?? Number.POSITIVE_INFINITY };
}

/** Every widget class module that registers an element (the `elements/` entries are generated from these). */
const ELEMENT_MODULES = readdirSync(resolve(DIST, "elements"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => basename(f, ".js"))
  .sort();

describe("per-element entries", () => {
  it("there is an entry per widget module, so the loop below is not vacuous", () => {
    expect(ELEMENT_MODULES.length).toBeGreaterThanOrEqual(19);
    expect(ELEMENT_MODULES).toContain("lu-kpi");
  });

  for (const m of ELEMENT_MODULES) {
    it(`elements/${m}.js carries its own widget module (+ the shared base) and no other element's`, async () => {
      const { modules } = await widgetsIn(`elements/${m}.js`);
      expect(modules).toContain(m);
      // `base` is the shared LuWidget, `virtual` the windowing helper the tables and chat share; `lu-embedded` draws the two elements it nests.
      const allowed = new Set([
        "base",
        "chatShared",
        "virtual",
        ...(m === "lu-chat" ? ["chatMarkdown"] : []),
        m,
        ...(m === "lu-embedded" ? ["lu-a2ui-view", "lu-sandbox"] : []),
      ]);
      expect(modules.filter((x) => !allowed.has(x))).toEqual([]);
    });
  }

  it("a one-widget entry is a fraction of the register-all entry", async () => {
    const one = await widgetsIn("elements/lu-kpi.js");
    const all = await widgetsIn("register.js");
    console.info(`elements/lu-kpi.js ${one.bytes} bytes; register.js ${all.bytes} bytes`);
    expect(all.modules).toEqual(expect.arrayContaining(ELEMENT_MODULES));
    expect(one.bytes).toBeLessThan(all.bytes / 2);
  });

  it("the plain DOM entry (renderBlueprintDom + registry) carries NO widget class at all", async () => {
    const { modules } = await widgetsIn("dom/index.js");
    expect(modules).toEqual([]);
  });
});

describe("package.json", () => {
  it("marks exactly the registering entries as side-effectful", () => {
    expect([...PKG.sideEffects].sort()).toEqual(["./dist/elements/*.js", "./dist/register.js"]);
  });

  it("exports the register entry and the per-element pattern", () => {
    expect(PKG.exports["./register"]).toBeDefined();
    expect(PKG.exports["./elements/*"]).toBeDefined();
  });
});
