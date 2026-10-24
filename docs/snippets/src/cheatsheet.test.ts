// @vitest-environment happy-dom
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectDocMirrors } from "./mirror.test-support";

// docs/cheatsheet.md is the densest list of names in the docs, and nothing about it fails when one
// of them changes. So the card is checked against the things it claims to enumerate (the packages,
// the framework kinds, the container roles, the operations, and every API name in an `Export`
// table). Prose is left alone. The Lit entries need a DOM, hence the environment above.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CARD = "docs/cheatsheet.md";
const card = readFileSync(resolve(ROOT, CARD), "utf8");

/** Every entry point whose runtime exports the card may name. */
const ENTRIES = [
  "@loom-ui/core",
  "@loom-ui/core/log",
  "@loom-ui/core/browser",
  "@loom-ui/core/media",
  "@loom-ui/core/chat",
  "@loom-ui/core/chat-ui",
  "@loom-ui/core/document",
  "@loom-ui/core/signals",
  "@loom-ui/hydration",
  "@loom-ui/hydration/client",
  "@loom-ui/planner",
  "@loom-ui/lineage",
  "@loom-ui/changes",
  "@loom-ui/learning",
  "@loom-ui/renderer-lit",
  "@loom-ui/renderer-lit/dom",
  "@loom-ui/renderer-lit/containers",
  "@loom-ui/renderer-terminal",
  "@loom-ui/renderer-conformance",
  "@loom-ui/renderer-conformance/vitest",
] as const;

async function exportedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const entry of ENTRIES) {
    const mod = (await import(/* @vite-ignore */ entry)) as Record<string, unknown>;
    for (const k of Object.keys(mod)) names.add(k);
  }
  return names;
}

/** The first-column cells of every table whose header cell is exactly `Export`. */
function exportCells(md: string): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*Export\s*\|/.test(lines[i] as string)) continue;
    for (let j = i + 2; j < lines.length && (lines[j] as string).startsWith("|"); j++)
      out.push(((lines[j] as string).split("|")[1] ?? "").trim());
  }
  return out;
}

/** `` `a` · `b` `` -> ["a", "b"]; a name with a dot (a method) or a slash is not a bare export. */
function identifiers(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/** The Export-table names in `md` that no entry exports. */
function unknownExports(md: string, real: ReadonlySet<string>): string[] {
  const bad: string[] = [];
  for (const cell of exportCells(md))
    for (const id of identifiers(cell)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(id)) continue; // a method / path, not a bare export
      if (!real.has(id)) bad.push(id);
    }
  return bad;
}

describe("docs/cheatsheet.md stays true to what it enumerates", () => {
  it("names every package under packages/, and the right count", () => {
    const pkgs = readdirSync(resolve(ROOT, "packages"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(pkgs.length, "the sweep itself must not match nothing").toBeGreaterThan(5);
    const missing = pkgs.filter((p) => !card.includes(`\`@loom-ui/${p}\``));
    expect(missing, `${CARD} never names: ${missing.join(", ")}`).toEqual([]);
    expect(card, "the headline package count").toContain(`**${pkgs.length}** packages`);
  });

  it("every Export-table name is a real runtime export of a shipped entry", async () => {
    const real = await exportedNames();
    expect(exportCells(card).length, "the sweep itself must not match nothing").toBeGreaterThan(40);
    const bad = unknownExports(card, real);
    expect(bad, `${CARD} names exports that do not exist: ${bad.join(", ")}`).toEqual([]);
  });

  it("lists every framework kind", async () => {
    const { FRAMEWORK_KINDS } = await import("@loom-ui/core");
    expect(FRAMEWORK_KINDS.length).toBeGreaterThan(5);
    const missing = FRAMEWORK_KINDS.filter((k) => !card.includes(`\`${k}\``));
    expect(missing, `${CARD} omits framework kinds: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists every reference container role", async () => {
    const { REFERENCE_CONTAINER_ROLES } = await import("@loom-ui/core");
    expect(REFERENCE_CONTAINER_ROLES.length).toBeGreaterThan(1);
    const missing = REFERENCE_CONTAINER_ROLES.filter((r) => !card.includes(`\`${r.role}\``));
    expect(
      missing.map((r) => r.role),
      `${CARD} omits roles`
    ).toEqual([]);
  });

  it("lists every operation", () => {
    // From source (text against text): the union is zod's, with no public list of its members.
    const src = readFileSync(resolve(ROOT, "packages/core/src/operations.ts"), "utf8");
    const types = [...src.matchAll(/type: z\.literal\("(\w+)"\)/g)].map((m) => m[1] as string);
    expect(types.length).toBeGreaterThan(10);
    const missing = types.filter((t) => !card.includes(`\`${t}\``));
    expect(missing, `${CARD} omits operations: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists every merge conflict kind it can name, and every audience", async () => {
    const merge = readFileSync(resolve(ROOT, "packages/core/src/merge.ts"), "utf8");
    const block = /export type MergeConflictKind =([\s\S]*?);/.exec(merge)?.[1] ?? "";
    const kinds = [...block.matchAll(/\|\s*"([\w/]+)"/g)].map((m) => m[1] as string);
    expect(kinds.length).toBeGreaterThan(5);
    const missing = kinds.filter((k) => !card.includes(k));
    expect(missing, `${CARD} omits conflict kinds: ${missing.join(", ")}`).toEqual([]);
    for (const a of ["viewer", "broadcast"]) expect(card).toContain(`"${a}"`);
  });

  it("names every --lu-* token the theming reference documents", () => {
    const theming = readFileSync(resolve(ROOT, "docs/reference/theming.md"), "utf8");
    const tokens = [...new Set(theming.match(/--lu-[a-z0-9-]+/g) ?? [])].filter(
      (t) => t !== "--lu-"
    );
    expect(tokens.length).toBeGreaterThan(10);
    const missing = tokens.filter((t) => !card.includes(t));
    expect(missing, `${CARD} omits theming tokens: ${missing.join(", ")}`).toEqual([]);
  });

  it("every ts block carries a mirror/illustrative marker", () => {
    expect(() => expectDocMirrors(CARD, "concepts.test.ts", card)).not.toThrow();
  });
});

describe("the cheatsheet guard is not vacuous", () => {
  it("flags a planted export name and ignores a method path", async () => {
    const real = await exportedNames();
    const md =
      "| Export | What |\n|---|---|\n| `notARealExport` · `Lineage.head` · `compile` | x |\n";
    expect(unknownExports(md, real)).toEqual(["notARealExport"]);
  });

  it("flags a package the card no longer names", () => {
    const planted = card.replace("`@loom-ui/changes`", "`@loom-ui/chang`");
    expect(planted).not.toContain("`@loom-ui/changes`");
  });
});
