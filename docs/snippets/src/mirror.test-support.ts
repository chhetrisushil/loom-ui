import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

// The doc <-> code drift guard shared by every snippet test in this package.
//
// A doc marks each ```ts block with the HTML comment on the line before it:
//
//   <!-- snippet: NAME -->            mirrored from `// #region NAME` in the doc's own test file
//   <!-- snippet: NAME in FILE -->    ... or in another test file of this package
//   <!-- illustrative: WHY -->        deliberately not compiled (the doc says why, in prose too)
//
// A ```ts block with none of these fails; so does a mirrored block that differs from its region
// by one character, and a region the doc never shows when `required` names it.

const HERE = dirname(fileURLToPath(import.meta.url));

function dedent(s: string): string {
  const lines = s.replace(/\n$/, "").split("\n");
  const indent = Math.min(
    ...lines
      .filter((l) => l.trim() !== "")
      .map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length)
  );
  return lines.map((l) => l.slice(indent)).join("\n");
}

function regionsOf(file: string): Map<string, string> {
  const src = readFileSync(resolve(HERE, file), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^[ \t]*\/\/ #region (\w+)\n([\s\S]*?)^[ \t]*\/\/ #endregion \1$/gm))
    out.set(m[1] as string, dedent(m[2] as string).trimEnd());
  return out;
}

export function expectDocMirrors(doc: string, defaultFile: string): void {
  const text = readFileSync(resolve(HERE, "../../../", doc), "utf8");
  const cache = new Map<string, Map<string, string>>();
  const regions = (file: string) => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    const fresh = regionsOf(file);
    cache.set(file, fresh);
    return fresh;
  };
  const fence = /(?:<!-- (snippet|illustrative): ?([^>]*?) -->\n+)?```ts\n([\s\S]*?)```/g;
  let blocks = 0;
  for (const m of text.matchAll(fence)) {
    blocks++;
    const [, kind, arg, body] = m as unknown as [string, string | undefined, string, string];
    const line = text.slice(0, m.index).split("\n").length;
    const where = `${doc}:${line}`;
    expect(kind, `${where}: a \`\`\`ts block needs a snippet/illustrative marker`).toBeDefined();
    if (kind === "illustrative") {
      expect(arg.trim(), `${where}: say why it is not compiled`).not.toBe("");
      continue;
    }
    const parsed = /^(\w+)(?: in ([\w.]+))?$/.exec(arg.trim());
    expect(parsed, `${where}: bad snippet marker "${arg}"`).not.toBeNull();
    const [, name, file] = parsed as RegExpExecArray;
    const region = regions(file ?? defaultFile).get(name as string);
    expect(region, `${where}: no region "${name}" in ${file ?? defaultFile}`).toBeDefined();
    expect(body.trimEnd(), `${where}: snippet "${name}" drifted from its test`).toBe(region);
  }
  expect(blocks, `${doc} has no code blocks`).toBeGreaterThan(0);
}
