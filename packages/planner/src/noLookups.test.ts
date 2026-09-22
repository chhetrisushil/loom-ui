import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [
  "@loom/plugin-mcp",
  "@loom/effect-runtime",
  "@loom/projection-runtime",
  "@loom/llm",
];

describe("the planner's own sources import no invoker, runtime or LLM package", () => {
  it("the planner's own sources import no invoker, runtime or LLM package (test files excluded: they may drive the real producer)", () => {
    const dir = join(__dirname);
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.endsWith(".test-support.ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const pkg of FORBIDDEN)
        if (src.includes(`"${pkg}`)) offenders.push(`${f} imports ${pkg}`);
    }
    expect(offenders).toEqual([]);
  });
});
