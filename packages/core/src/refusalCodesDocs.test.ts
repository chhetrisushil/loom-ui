import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The docs promise a COMPLETE list of the codes `apply` can refuse with, so consumers can handle
// every one. Derived from operations.ts, so a new `refuse("…")` fails here until it is documented.
const ROOT = resolve(__dirname, "../../..");
const source = readFileSync(resolve(__dirname, "operations.ts"), "utf8");
const codes = [...new Set([...source.matchAll(/refuse\(\s*"([a-z-]+)"/g)].map((m) => m[1]))].sort();

/** The paragraph (README) or bullet (AGENTS) that carries the list, found by its lead-in. */
function section(file: string, lead: string): string {
  const md = readFileSync(resolve(ROOT, file), "utf8");
  const start = md.indexOf(lead);
  if (start < 0) return "";
  const end = md.indexOf("\n\n", start);
  const block = md.slice(start, end < 0 ? undefined : end);
  // AGENTS.md bullets are separated by the next "\n- ", not a blank line.
  const next = block.indexOf("\n- ", 1);
  return next < 0 ? block : block.slice(0, next);
}

describe("every op-level refusal code is documented", () => {
  it("the extraction finds the codes (guard against a vacuous pass)", () => {
    expect(codes).toContain("missing-node");
    expect(codes).toContain("placement-out-of-range");
    expect(codes.length).toBeGreaterThanOrEqual(15);
  });
  for (const [file, lead] of [
    ["README.md", "**Op refusal codes.**"],
    ["AGENTS.md", "- Op refusal codes"],
  ] as const)
    it(`${file} lists every code apply can return`, () => {
      const text = section(file, lead);
      expect(text, `${file} has no "${lead}" section`).not.toBe("");
      expect(codes.filter((c) => !text.includes(`\`${c}\``))).toEqual([]);
    });
});
