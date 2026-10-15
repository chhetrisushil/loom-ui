import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// loom-ui is a framework anyone can use. It must not carry a consumer's name, prefix or
// theme tokens: a consumer adapts at its own boundary. The one allowed place to name a
// consumer is README.md's "## Consumers" section.
//
// U20 widened this beyond one consumer's spelling. It now also catches the CLASS of consumer-specific
// nouns that leaked into comments: the "studio" / "authoring shell" a consumer calls its own app, and
// the names of loom's example apps (a consumer, not the framework). Word boundaries keep it from
// tripping on ordinary English words that contain the same letters, e.g. "genuinely" — see the regex
// unit tests below. Write "the host" / "the embedding app" / "every surface" instead.
const ROOT = resolve(__dirname, "../../..");
const CONSUMER = new RegExp(
  [
    String.raw`\bgenui\b`,
    String.raw`\bgx-`,
    String.raw`--gx-`,
    String.raw`\bstudio\b`,
    String.raw`\bauthoring[- ]shell\b`,
    String.raw`\b(?:db-command-center|incident-war-room|db-observability|cloud-command-center|db-sentinel|schema-migration-planner|agent-swarm)\b`,
  ].join("|"),
  "i"
);
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

/** The sweep itself, over any list of files — also run below on a planted file to prove it can fail. */
function sweep(paths: readonly string[], root: string): string[] {
  const hits: string[] = [];
  for (const f of paths) {
    if (f.endsWith("genericity.test.ts")) continue;
    let text = readFileSync(f, "utf8");
    if (f.endsWith("README.md")) text = withoutConsumersSection(text);
    text.split("\n").forEach((line, i) => {
      if (CONSUMER.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
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

  it("flags the consumer nouns that leaked into comments (U20), not words that merely contain them", () => {
    expect(CONSUMER.test("// the studio re-hydrates every time-bound widget")).toBe(true);
    expect(CONSUMER.test("Shared by the studio and the authoring shell")).toBe(true);
    expect(CONSUMER.test("see examples/incident-war-room")).toBe(true);
    expect(CONSUMER.test("a studious reader of studios-in-general")).toBe(false);
  });

  it("flags a --gx- theme token", () => {
    expect(CONSUMER.test("color: var(--gx-text, #e6edf3);")).toBe(true);
  });
});

describe("loom-ui names no consumer", () => {
  const scanned = [
    ...files(join(ROOT, "packages")),
    ...files(join(ROOT, "docs", "reference")),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "README.md"),
  ];

  it("scans something (the sweep can't silently match nothing)", () => {
    expect(scanned.length).toBeGreaterThan(50);
  });

  it("no source, test, doc or config names a consumer or uses its prefix", () => {
    expect(sweep(scanned, ROOT)).toEqual([]);
  });

  it("NON-VACUOUS: the same sweep fails on a planted consumer name", () => {
    const dir = mkdtempSync(join(tmpdir(), "lu-genericity-"));
    try {
      const planted = join(dir, "planted.ts");
      writeFileSync(planted, "export const x = 1;\n// the studio re-hydrates this widget\n");
      const hits = sweep([planted], dir);
      expect(hits).toEqual(["planted.ts:2: // the studio re-hydrates this widget"]);
      writeFileSync(planted, "// uses --gx-text and genUI\n");
      expect(sweep([planted], dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
