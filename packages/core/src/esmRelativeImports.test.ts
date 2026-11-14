import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A `"type": "module"` package is loaded by Node's ESM loader, which never guesses an extension:
// `import "./a11y"` in its dist is ERR_MODULE_NOT_FOUND for every npm consumer. tsc copies a
// specifier verbatim, and vitest / Vite / `link:` siblings resolve it anyway, so nothing else
// catches it. Every relative specifier in such a package's shipped `src` must name its `.js`.
const ROOT = resolve(__dirname, "../../..");
const SPEC = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.?\/[^"']*)["']/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|\.test-support\.ts$|\.d\.ts$/.test(name))
      out.push(p);
  }
  return out;
}

/** `file:line: specifier` for every relative specifier with no extension in `files`. */
function extensionless(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(SPEC)) {
          const spec = m[1] as string;
          if (!/\.(js|mjs|cjs|json|css)$/.test(spec))
            hits.push(`${relative(ROOT, f)}:${i + 1}: ${spec}`);
        }
      });
  }
  return hits;
}

/** The workspace packages that publish ESM: public and `"type": "module"`. */
function esmPackages(): string[] {
  return readdirSync(join(ROOT, "packages")).filter((d) => {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "packages", d, "package.json"), "utf8"));
      return pkg.type === "module" && pkg.private !== true;
    } catch {
      return false;
    }
  });
}

describe("ESM packages import relative files with an extension", () => {
  it("covers the ESM packages (not vacuous)", () => {
    expect(esmPackages()).toEqual(expect.arrayContaining(["renderer-conformance", "renderer-lit"]));
  });

  for (const d of esmPackages()) {
    it(`packages/${d}/src names .js on every relative import`, () => {
      expect(extensionless(sources(join(ROOT, "packages", d, "src")))).toEqual([]);
    });
  }

  it("flags a planted extensionless import, static and dynamic (non-vacuity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lu-esm-"));
    try {
      const f = join(dir, "planted.ts");
      writeFileSync(
        f,
        'import { a } from "./a";\nexport * from "../b";\nconst c = import("./c");\nimport "./d.js";\n'
      );
      expect(extensionless([f]).map((h) => h.split(": ")[1])).toEqual(["./a", "../b", "./c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
