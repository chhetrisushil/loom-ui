import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
//  - One copy per runtime: a build may only name a sibling `@loom-ui/*` package through its `exports`
//    map (a deep `dist/...` path would bypass the conditions and load the OTHER build of it), and a
//    relative import stays inside its own build (`dist/esm` never reaches `dist/*.js`, nor back).
//    Otherwise a consumer holds a CJS and an ESM copy of the same package (two registries, two
//    `instanceof` worlds).
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

  describe("one copy per runtime (no require/import mix)", () => {
    const files = (d: string, skip: (p: string) => boolean = () => false): string[] =>
      existsSync(d)
        ? readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const p = resolve(d, e.name);
            return skip(p)
              ? []
              : e.isDirectory()
                ? files(p, skip)
                : e.name.endsWith(".js")
                  ? [p]
                  : [];
          })
        : [];
    /** Module specifiers a built file names: `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
    const specifiers = (src: string): string[] =>
      [
        ...stripComments(src).matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']([^"']+)["']/g
        ),
      ].map((m) => m[1] as string);
    // Comments name specifiers in prose; only code counts. (No emitted file here has `//` in a string.)
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const byName = new Map(pkgs.map((p) => [p.pkg.name, p]));
    /** `@loom-ui/x/sub` -> [package, "./sub"]; `@loom-ui/x` -> [package, "."]. */
    const split = (spec: string): [string, string] => {
      const [scope, name, ...rest] = spec.split("/");
      return [`${scope}/${name}`, rest.length === 0 ? "." : `./${rest.join("/")}`];
    };
    type Build = { label: string; condition: "import" | "node"; root: string; files: string[] };
    const builds: Build[] = pkgs.flatMap(({ dir, pkg }) => {
      const dist = resolve(dir, "dist");
      const esmDir = resolve(dist, "esm");
      if (pkg.type === "module")
        return [
          {
            label: `${pkg.name} (ESM)`,
            condition: "import" as const,
            root: dist,
            files: files(dist),
          },
        ];
      return [
        {
          label: `${pkg.name} (ESM)`,
          condition: "import" as const,
          root: esmDir,
          files: files(esmDir),
        },
        {
          label: `${pkg.name} (CJS)`,
          condition: "node" as const,
          root: dist,
          files: files(dist, (p) => p === esmDir),
        },
      ];
    });

    it("is not vacuous: both builds of the dual packages are scanned and some sibling imports exist", () => {
      expect(builds.length).toBeGreaterThanOrEqual(2 * dualPkgs.length);
      for (const b of builds) expect(b.files.length, b.label).toBeGreaterThan(0);
      const siblingImports = builds.flatMap((b) =>
        b.files.flatMap((f) =>
          specifiers(readFileSync(f, "utf8")).filter((x) => x.startsWith("@loom-ui/"))
        )
      );
      expect(siblingImports.length).toBeGreaterThan(10);
    });

    it("a sibling @loom-ui package is named only through an export that has this build's condition", () => {
      for (const b of builds)
        for (const f of b.files)
          for (const spec of specifiers(readFileSync(f, "utf8"))) {
            if (!spec.startsWith("@loom-ui/")) continue;
            const [name, sub] = split(spec);
            const target = byName.get(name);
            const where = `${b.label}: ${relative(PACKAGES, f)} -> ${spec}`;
            expect(target, where).not.toBeUndefined();
            const exports = target?.pkg.exports ?? {};
            const key = Object.keys(exports).find(
              (k) => k === sub || (k.endsWith("/*") && sub.startsWith(k.slice(0, -1)))
            );
            const cond = key === undefined ? undefined : exports[key];
            expect(
              cond,
              `${where} is not an export (a deep path bypasses the conditions)`
            ).not.toBeUndefined();
            // ESM resolves `import`; an ESM-first package has only `default`, a dual one has both.
            expect(cond?.[b.condition] ?? cond?.default, where).not.toBeUndefined();
          }
    });

    it("a relative import stays inside its own build", () => {
      for (const b of builds)
        for (const f of b.files)
          for (const spec of specifiers(readFileSync(f, "utf8"))) {
            if (!spec.startsWith(".")) continue;
            const hit = resolve(dirname(f), spec);
            const rel = relative(b.root, hit);
            const where = `${b.label}: ${relative(PACKAGES, f)} -> ${spec}`;
            expect(rel.startsWith(".."), where).toBe(false);
            // the CJS build owns dist/ minus dist/esm
            if (b.label.endsWith("(CJS)")) expect(rel.split("/")[0], where).not.toBe("esm");
          }
    });
  });

  it("renderer-lit keeps its element-registering modules listed as side-effectful", () => {
    const lit = pkgs.find((p) => p.pkg.name === "@loom-ui/renderer-lit")?.pkg;
    expect(lit?.sideEffects).toEqual(["./dist/register.js", "./dist/elements/*.js"]);
  });
});
