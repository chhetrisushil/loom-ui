import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── ESM packaging (F3) ───────────────────────────────────────────────────────────
// A CommonJS build cannot be tree-shaken: a bundler keeps every module a barrel `require`s. Every
// loom-ui package therefore publishes an ESM build too, and states which of its modules have side
// effects, so a browser embed bundle contains only what it uses.
//
//  - CJS-first packages (core, hydration, …) keep `dist/*.js` for Node (`node` and `default`
//    conditions, so `require`, `import` under Node, vitest and every server keep working) and add
//    `dist/esm/**` behind the `import` condition, which a bundler targeting the browser resolves
//    (it does not set `node`). `node` MUST come before `import`: Node sets both.
//  - ESM-first packages (renderer-lit, renderer-conformance) are `"type": "module"` already.
//
// Needs `pnpm build` first, like every other guard that reads `dist`.

const PACKAGES = resolve(__dirname, "../..");
type Pkg = {
  name: string;
  type?: string;
  module?: string;
  sideEffects?: boolean | string[];
  exports: Record<string, Record<string, string>>;
};
const pkgs = readdirSync(PACKAGES)
  .filter((d) => existsSync(resolve(PACKAGES, d, "package.json")))
  .map((d) => ({
    dir: resolve(PACKAGES, d),
    pkg: JSON.parse(readFileSync(resolve(PACKAGES, d, "package.json"), "utf8")) as Pkg,
  }));
const dualPkgs = pkgs.filter((p) => p.pkg.type !== "module");

describe("ESM packaging", () => {
  it("the loop is not vacuous: CJS-first and ESM-first packages are both seen", () => {
    expect(dualPkgs.length).toBeGreaterThanOrEqual(7);
    expect(pkgs.some((p) => p.pkg.type === "module")).toBe(true);
  });

  it("every package states its sideEffects (a missing field means 'everything has side effects')", () => {
    for (const { pkg } of pkgs) expect(pkg.sideEffects, pkg.name).not.toBeUndefined();
  });

  for (const { dir, pkg } of dualPkgs) {
    describe(pkg.name, () => {
      it("every export is node+import+default, node before import, import pointing at a built dist/esm file", () => {
        for (const [subpath, cond] of Object.entries(pkg.exports)) {
          const keys = Object.keys(cond);
          expect(keys, subpath).toEqual(["types", "node", "import", "default"]);
          expect(cond.node, subpath).toBe(cond.default);
          expect(cond.import, subpath).toBe(
            (cond.default as string).replace("./dist/", "./dist/esm/")
          );
          expect(
            existsSync(resolve(dir, cond.import as string)),
            `${subpath} -> ${cond.import}`
          ).toBe(true);
        }
        expect(pkg.module).toBe("./dist/esm/index.js");
      });

      it("has no pure-CJS construct in its ESM build (a stray require() defeats tree-shaking)", () => {
        const walk = (d: string): string[] =>
          readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory()
              ? walk(resolve(d, e.name))
              : e.name.endsWith(".js")
                ? [resolve(d, e.name)]
                : []
          );
        const files = walk(resolve(dir, "dist/esm"));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
          const src = readFileSync(f, "utf8");
          expect(src, f).not.toMatch(
            /\bexports\.\w+\s*=|Object\.defineProperty\(exports|\brequire\(\s*["']/
          );
        }
      });
    });
  }

  it("renderer-lit keeps its element-registering modules listed as side-effectful", () => {
    const lit = pkgs.find((p) => p.pkg.name === "@loom-ui/renderer-lit")?.pkg;
    expect(lit?.sideEffects).toEqual(["./dist/register.js", "./dist/elements/*.js"]);
  });
});
