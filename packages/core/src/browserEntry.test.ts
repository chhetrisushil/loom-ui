import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as main from "./index";

// `@loom-ui/core/browser` is the entry a browser renderer bundles. It must stay zod-free: walk
// the `require` graph of the BUILT `dist/browser.js` (needs `pnpm build`, like every consumer).
const DIST = resolve(__dirname, "../dist");

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] as string;
      if (spec.startsWith(".")) stack.push(resolve(file, "..", `${spec}.js`));
      else seen.add(`pkg:${spec}`);
    }
  }
  return seen;
}

describe("@loom-ui/core/browser", () => {
  it("reaches no package at all: no zod, no loom runtime, only its own zod-free modules", () => {
    const graph = [...reach(resolve(DIST, "browser.js"))];
    expect(graph.filter((g) => g.startsWith("pkg:"))).toEqual([]);
    const files = graph.map((g) => g.replace(`${DIST}/`, "")).sort();
    expect(files).toEqual([
      "action.js",
      "browser.js",
      "chatValue.js",
      "containerRoles.js",
      "format.js",
      "kindValues.js",
      "mediaRef.js",
      "paths.js",
      "streamText.js",
    ]);
  });

  it("@loom-ui/core/signals (U11, opt-in) reaches no package and no other core module", () => {
    const graph = [...reach(resolve(DIST, "signals.js"))];
    expect(graph.filter((g) => g.startsWith("pkg:"))).toEqual([]);
    expect(graph.map((g) => g.replace(`${DIST}/`, "")).sort()).toEqual(["signals.js"]);
  });

  it("is the same vocabulary as the main entry, not a fork", async () => {
    const browser = await import("./browser");
    for (const name of Object.keys(browser) as (keyof typeof browser)[]) {
      if (name === "checkKindValue") continue; // zod-free twin; parity is kindValues.test.ts
      if (name === "isLocalizedText") continue;
      expect(browser[name], name).toBe((main as Record<string, unknown>)[name]);
    }
  });
});
