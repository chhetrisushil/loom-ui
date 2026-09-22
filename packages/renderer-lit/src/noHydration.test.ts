import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A widget's status is a Blueprint concern (`binding.status.path`, ADR 0097 D2), resolved by
// loom's traversal before a renderer ever runs. `@loom-ui/hydration` is how the APP fetches and
// publishes the values behind that projection; an adapter that reached for it would be reading
// the projection directly again — the exact coupling IR 2.0.0 removed — and would also bind the
// browser bundle to a package that speaks to loom's invoker. It stays a devDependency here,
// which the test files may (and do) drive; the adapter path may not touch it.
const FORBIDDEN = ["@loom-ui/hydration"];

/** Every non-test `.ts` under `src`, recursively — the adapter has subdirectories, unlike the planner. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".test-support.ts")
    )
      out.push(full);
  }
  return out;
}

describe("the Lit adapter's own sources import no hydration package", () => {
  it("the Lit adapter's own sources import no hydration package (test files excluded: they may drive the real store)", () => {
    const root = join(__dirname);
    const files = sources(root);
    // A walk that finds nothing would pass vacuously; the adapter has sources.
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const pkg of FORBIDDEN)
        if (src.includes(`"${pkg}`)) offenders.push(`${f.slice(root.length + 1)} imports ${pkg}`);
    }
    expect(offenders).toEqual([]);
  });
});
