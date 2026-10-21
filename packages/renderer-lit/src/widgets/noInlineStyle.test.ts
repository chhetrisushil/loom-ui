import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A strict Content-Security-Policy (`style-src 'self'`, no 'unsafe-inline') rejects every inline
// `style` ATTRIBUTE, including an empty `style=""` binding. Lit's `styleMap` sets properties through
// the CSSOM, which CSP allows, but `styleMap` commits its first render as an attribute string, so no
// `style=` binding of any kind is allowed: use `cssomStyle` (src/cssomStyle.ts), an element directive.

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.test(-support)?\.ts$/.test(name) ? [p] : [];
  });
}

describe("renderer-lit emits no inline style attribute", () => {
  it("no template binds a `style=` attribute", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/\bstyle\s*=/g)) {
            void m;
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
