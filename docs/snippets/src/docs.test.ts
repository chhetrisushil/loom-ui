import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural checks over the hand-written docs this package backs: every page is accounted for,
// and every relative link and heading anchor resolves. (The code blocks themselves are checked by
// each snippet test through `expectDocMirrors`.)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GUIDES = readdirSync(resolve(ROOT, "docs/guides")).filter((f) => f.endsWith(".md"));
const PAGES = [
  "docs/getting-started.md",
  "docs/user-guide.md",
  ...GUIDES.map((g) => `docs/guides/${g}`),
];

// Pages owned by the reference docs: they are written alongside these guides and linked, but this
// package does not own them, so a link INTO them is not resolved here.
const NOT_OURS = /^docs\/reference\//;

/** GitHub's heading slug: lower-case, drop punctuation, spaces to hyphens. */
const slug = (h: string): string =>
  h
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1] as string));
  }
  return out;
}

describe("the hand-written docs", () => {
  it("every guide is indexed in the user guide", () => {
    const index = readFileSync(resolve(ROOT, "docs/user-guide.md"), "utf8");
    for (const g of GUIDES)
      expect(index, `docs/guides/${g} is not linked`).toContain(`guides/${g}`);
  });

  it("every relative link and anchor resolves", () => {
    const bad: string[] = [];
    for (const page of PAGES) {
      const text = readFileSync(resolve(ROOT, page), "utf8");
      const body = text.replace(/```[\s\S]*?```/g, "");
      for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1] as string;
        if (/^[a-z]+:/i.test(target)) continue;
        const [path = "", frag] = target.split("#");
        const file =
          path === "" ? page : resolve(dirname(resolve(ROOT, page)), path).replace(`${ROOT}/`, "");
        if (NOT_OURS.test(file)) continue;
        const abs = resolve(ROOT, file);
        if (!existsSync(abs)) {
          bad.push(`${page}: ${target} does not exist`);
          continue;
        }
        if (
          frag !== undefined &&
          abs.endsWith(".md") &&
          !anchors(readFileSync(abs, "utf8")).has(frag)
        )
          bad.push(`${page}: ${target} has no such heading`);
      }
    }
    expect(bad).toEqual([]);
  });
});
