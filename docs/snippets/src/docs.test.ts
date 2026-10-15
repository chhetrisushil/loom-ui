import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectDocMirrors } from "./mirror.test-support";

// Structural checks over the hand-written docs this package backs: every guide is indexed, and every
// doc with code blocks is wired to the mirror guard. (Relative links and anchors are checked by
// packages/core/src/docLinks.test.ts; the code blocks themselves by each snippet test through
// `expectDocMirrors`.)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GUIDES = readdirSync(resolve(ROOT, "docs/guides")).filter((f) => f.endsWith(".md"));
const PAGES = [
  "docs/getting-started.md",
  "docs/user-guide.md",
  ...GUIDES.map((g) => `docs/guides/${g}`),
];

describe("the hand-written docs", () => {
  it("every guide is indexed in the user guide", () => {
    const index = readFileSync(resolve(ROOT, "docs/user-guide.md"), "utf8");
    for (const g of GUIDES)
      expect(index, `docs/guides/${g} is not linked`).toContain(`guides/${g}`);
  });

  it("every doc with a ts/tsx block is wired to expectDocMirrors", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wired = new Set<string>();
    for (const f of readdirSync(here).filter((x) => x.endsWith(".test.ts")))
      for (const m of readFileSync(resolve(here, f), "utf8").matchAll(
        /expectDocMirrors\(\s*"([^"]+)"/g
      ))
        wired.add(m[1] as string);
    for (const page of PAGES) {
      const text = readFileSync(resolve(ROOT, page), "utf8");
      if (/^```tsx?$/m.test(text))
        expect(wired, `${page} has code blocks but no mirror test`).toContain(page);
    }
  });
});

describe("the mirror guard is not vacuous", () => {
  const doc = "docs/user-guide.md";
  const text = readFileSync(resolve(ROOT, doc), "utf8");
  const marked = /(<!-- snippet: [^>]*-->\n+```ts\n)([\s\S]*?)(```)/.exec(text);

  it("passes on the real page", () => {
    expect(() => expectDocMirrors(doc, "concepts.test.ts", text)).not.toThrow();
  });

  it("fails when a mirrored block differs from its region by one character", () => {
    expect(marked, "user guide has a mirrored block to plant drift in").not.toBeNull();
    const [whole = "", head = "", body = "", tail = ""] = marked as RegExpExecArray;
    const drifted = text.replace(whole, `${head}${body.replace(/\w/, "X")}${tail}`);
    expect(drifted).not.toBe(text);
    expect(() => expectDocMirrors(doc, "concepts.test.ts", drifted)).toThrow(/drifted/);
  });

  it("fails on an unmarked ts block and an unmarked tsx block", () => {
    expect(() =>
      expectDocMirrors(doc, "concepts.test.ts", "# x\n\n```ts\nconst a = 1;\n```\n")
    ).toThrow(/needs a snippet\/illustrative marker/);
    expect(() =>
      expectDocMirrors(doc, "concepts.test.ts", "# x\n\n```tsx\nconst a = <b />;\n```\n")
    ).toThrow(/needs a snippet\/illustrative marker/);
  });

  it("fails an illustrative marker with no reason", () => {
    expect(() =>
      expectDocMirrors(doc, "concepts.test.ts", "<!-- illustrative: -->\n\n```ts\nx\n```\n")
    ).toThrow(/say why/);
  });
});
