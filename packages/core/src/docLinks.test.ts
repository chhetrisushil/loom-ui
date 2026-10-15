import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The docs link to each other (README -> docs/reference -> package READMEs). A moved or renamed page
// must fail here rather than leave a dead link. Repo-level, so it lives beside genericity.test.ts.
const ROOT = resolve(__dirname, "../../..");
const SKIP = new Set(["node_modules", "dist", ".git", ".superpowers", "coverage"]);

/**
 * Pages written by a companion change that may not be on this branch yet. A link to one is not
 * checked; once the page exists, it is checked like any other. Remove an entry when its page lands.
 */
const PENDING = new Set(["docs/getting-started.md", "docs/user-guide.md"]);

function markdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) markdown(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** The pages whose links are checked: README, AGENTS, everything under docs/, every package README. */
function checked(root: string): string[] {
  const pkgs = join(root, "packages");
  return [
    ...["README.md", "AGENTS.md"].map((f) => join(root, f)).filter(existsSync),
    ...(existsSync(join(root, "docs")) ? markdown(join(root, "docs")) : []),
    ...(existsSync(pkgs)
      ? readdirSync(pkgs)
          .map((d) => join(pkgs, d, "README.md"))
          .filter(existsSync)
      : []),
  ];
}

/** GitHub's heading slug: lowercase, drop punctuation except hyphens, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) fence = !fence;
    if (fence) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = slug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Every relative link in `files` whose file (or heading anchor) does not exist. */
function broken(files: readonly string[], root: string): string[] {
  const problems: string[] = [];
  for (const file of files) {
    let fence = false;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trimStart().startsWith("```")) fence = !fence;
        if (fence) return;
        const text = line.replace(/`[^`]*`/g, "");
        for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          const href = m[1] ?? "";
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http:, mailto:, ...
          const [pathPart = "", hash] = href.split("#");
          const target = pathPart === "" ? file : resolve(dirname(file), pathPart);
          const rel = relative(root, target);
          if (rel.startsWith("..")) continue; // a sibling repo (../loom): not ours to check
          if (PENDING.has(rel) && !existsSync(target)) continue;
          const at = `${relative(root, file)}:${i + 1}: ${href}`;
          if (!existsSync(target)) {
            problems.push(`${at} (no such file)`);
          } else if (
            hash &&
            target.endsWith(".md") &&
            !anchors(readFileSync(target, "utf8")).has(hash)
          ) {
            problems.push(`${at} (no such heading)`);
          }
        }
      });
  }
  return problems;
}

describe("every relative link in the docs resolves", () => {
  const files = checked(ROOT);

  it("scans the README, the reference pages and every package README", () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain("README.md");
    expect(rel).toContain("docs/reference/composition.md");
    expect(
      rel.filter((f) => /^packages\/[^/]+\/README\.md$/.test(f)).length
    ).toBeGreaterThanOrEqual(9);
  });

  it("no link points at a missing file or heading", () => {
    expect(broken(files, ROOT)).toEqual([]);
  });

  it("NON-VACUOUS: the same sweep fails on a planted broken file link and heading link", () => {
    const dir = mkdtempSync(join(tmpdir(), "lu-doclinks-"));
    try {
      writeFileSync(join(dir, "a.md"), "# A\n\n## Real heading\n");
      writeFileSync(
        join(dir, "README.md"),
        "[ok](a.md) [ok2](a.md#real-heading) [gone](missing.md) [bad](a.md#nope) `[code](ignored.md)`\n"
      );
      expect(broken([join(dir, "README.md")], dir)).toEqual([
        "README.md:1: missing.md (no such file)",
        "README.md:1: a.md#nope (no such heading)",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
