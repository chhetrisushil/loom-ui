import { jsonSchemaHash } from "@loom/core";

// The output-shape fingerprint, client-safe. This MIRRORS `shapeHash` in `@loom/plugin-sandbox`
// (ADR 0064) because that package's entry pulls QuickJS; `shape.test.ts` asserts the two agree
// on a corpus, so a drift in either fails the build. Same skeleton: primitives -> typeof, objects
// -> sorted key/shape maps, arrays -> the deduplicated, canonically sorted element shapes.

type Shape = string | Shape[] | { [key: string]: Shape };
const MAX_SHAPE_DEPTH = 1024;

function shapeAt(value: unknown, depth: number): Shape {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  if (depth >= MAX_SHAPE_DEPTH) {
    throw new Error(`shapeOf: depth limit exceeded (${MAX_SHAPE_DEPTH})`);
  }
  if (Array.isArray(value)) {
    const shapes = new Map<string, Shape>();
    for (const v of value) {
      const s = shapeAt(v, depth + 1);
      shapes.set(JSON.stringify(s), s);
    }
    return [...shapes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
  }
  if (t === "object") {
    const out: { [key: string]: Shape } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = shapeAt(v, depth + 1);
    }
    return out;
  }
  return t;
}

/** The output-shape fingerprint. The planner pins `ProviderSpec.outputShapeHash` with THIS function. */
export function outputShapeHashOf(value: unknown): string {
  return jsonSchemaHash(shapeAt(value, 0));
}
