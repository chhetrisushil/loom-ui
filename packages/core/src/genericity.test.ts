import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// loom-ui is a framework anyone can use. It must not carry a consumer's name, prefix or
// theme tokens: a consumer adapts at its own boundary. The one allowed place to name a
// consumer is README.md's "## Consumers" section.
//
// The word boundary before "genui" keeps this from tripping on ordinary English words that
// happen to contain the same letters, e.g. "genuinely" — see the regex unit tests below.
const ROOT = resolve(__dirname, "../../..");
const CONSUMER = /\bgenui\b|\bgx-|--gx-/i;
const SKIP = new Set(["node_modules", "dist", ".git", ".superpowers", "coverage"]);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|js|md|json|css|html)$/.test(name)) out.push(p);
  }
  return out;
}

function withoutConsumersSection(md: string): string {
  return md.replace(/^## Consumers\n[\s\S]*?(?=^## |\s*$(?![\s\S]))/m, "");
}

// The genericity rule itself, in AGENTS.md's "## Rules" list, names genUI as the worked example
// of "a consumer" while STATING the no-consumer-names rule — the same self-describing role
// README's "## Consumers" section plays. It is the one line in AGENTS.md allowed to do this.
function withoutGenericityRuleLine(md: string): string {
  return md
    .split("\n")
    .filter(
      (line) => !line.startsWith("- loom-ui is a generic UI framework on top of loom, for ANY app;")
    )
    .join("\n");
}

describe("the CONSUMER pattern matches a name, not a word that contains its letters", () => {
  it("does not flag 'genuinely', which contains genui but is not the consumer's name", () => {
    expect(
      CONSUMER.test("Three genuinely distinct cues, not the same text painted three colours.")
    ).toBe(false);
  });

  it("flags 'genUI' as a consumer mention", () => {
    expect(CONSUMER.test("genUI renders it generically")).toBe(true);
  });

  it("flags a --gx- theme token", () => {
    expect(CONSUMER.test("color: var(--gx-text, #e6edf3);")).toBe(true);
  });
});

describe("loom-ui names no consumer", () => {
  const scanned = [
    ...files(join(ROOT, "packages")),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "README.md"),
  ];

  it("scans something (the sweep can't silently match nothing)", () => {
    expect(scanned.length).toBeGreaterThan(50);
  });

  it("no source, test, doc or config names a consumer or uses its prefix", () => {
    const hits: string[] = [];
    for (const f of scanned) {
      if (f.endsWith("genericity.test.ts")) continue;
      let text = readFileSync(f, "utf8");
      if (f.endsWith("README.md")) text = withoutConsumersSection(text);
      if (f.endsWith("AGENTS.md")) text = withoutGenericityRuleLine(text);
      text.split("\n").forEach((line, i) => {
        if (CONSUMER.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
