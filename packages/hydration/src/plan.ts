import type { Finding, MCPToolNode } from "@loom-ui/core";

// ── Graph scheduling and argument templating ──────────────────────────────────
// A ProviderSpec's executionGraph is a DAG of MCP steps. Steps run in topological WAVES (every
// step in a wave has all its in-graph dependencies in earlier waves). A dependency naming a step
// outside the graph is treated as satisfied — the planner may reference a step it pruned — and a
// cycle is reported, never looped over. Arguments may embed `{{steps.<id>.output.<path>}}`,
// resolved from an earlier step's raw output over OWN properties only: the path is model-written
// and walked over a tool response, so an unguarded walk is a prototype-pollution read. An index
// past the end of a present array is not a bad path — the upstream answered with no such row —
// and is reported apart from every other miss (`walkPath`), so it can publish `empty`.

export function topoWaves(nodes: readonly MCPToolNode[]): {
  waves: MCPToolNode[][];
  cycle: string[];
} {
  const ids = new Set(nodes.map((n) => n.stepId));
  const placed = new Set<string>();
  const waves: MCPToolNode[][] = [];
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const wave = remaining.filter((n) => n.dependsOn.every((d) => placed.has(d) || !ids.has(d)));
    if (wave.length === 0) return { waves, cycle: remaining.map((n) => n.stepId) };
    waves.push(wave);
    for (const n of wave) placed.add(n.stepId);
    remaining = remaining.filter((n) => !placed.has(n.stepId));
  }
  return { waves, cycle: [] };
}

export function terminalSteps(nodes: readonly MCPToolNode[]): MCPToolNode[] {
  const depended = new Set(nodes.flatMap((n) => n.dependsOn));
  return nodes.filter((n) => !depended.has(n.stepId));
}

const SEGMENT = /^([^[\]]+)((?:\[\d+\])*)$/;

/**
 * Why a path walk found nothing. `out-of-range`: the walk stopped at an `[i]` applied to a value
 * that IS an array, with `i >= length` — the path is right, the upstream just has no such row (the
 * row count is DATA). `absent`: every other miss — a missing own key, `null` or a primitive
 * mid-path, an index on a non-array, a malformed segment — a BAD PATH.
 */
export type PathMiss = "out-of-range" | "absent";

/** Dotted path with optional `[i]` indices, own properties only. A present `null` resolves to `null`. */
export function walkPath(
  obj: unknown,
  dotted: string
): { ok: true; value: unknown } | { ok: false; cause: PathMiss } {
  const absent = { ok: false, cause: "absent" } as const;
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    const m = SEGMENT.exec(part);
    if (!m || cur === null || typeof cur !== "object") return absent;
    const key = m[1] as string;
    if (!Object.hasOwn(cur, key)) return absent;
    cur = (cur as Record<string, unknown>)[key];
    for (const idx of (m[2] ?? "").match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return absent;
      const i = Number(idx);
      if (i >= cur.length) return { ok: false, cause: "out-of-range" };
      cur = cur[i];
    }
  }
  return { ok: true, value: cur };
}

/** `walkPath`'s value, or `undefined` when anything is missing. */
export function resolvePath(obj: unknown, dotted: string): unknown {
  const r = walkPath(obj, dotted);
  return r.ok ? r.value : undefined;
}

export const STEP_TEMPLATE = /^\{\{steps\.([^.}]+)\.output(?:\.(.+))?\}\}$/;

/**
 * Substitute every `{{steps.<id>.output.<path>}}` in the step's arguments. EVERY template is
 * walked: a bad path anywhere (`absent`, or a step with no output) is `unresolved-step-reference`
 * (an error) and wins; otherwise an index past the end of a present upstream array is
 * `upstream-empty` (a warn — the upstream answered with no such row; loom ADR 0100's `empty`).
 */
export function resolveArguments(
  node: MCPToolNode,
  outputs: ReadonlyMap<string, unknown>
): { ok: true; args: Record<string, unknown> } | { ok: false; finding: Finding } {
  let bad: Finding | undefined;
  let empty: Finding | undefined;
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = STEP_TEMPLATE.exec(v);
      if (!m) return v;
      const stepId = m[1] as string;
      if (!outputs.has(stepId)) {
        bad ??= {
          code: "unresolved-step-reference",
          severity: "error",
          message: `step "${node.stepId}" references "${stepId}", which has no output`,
        };
        return v;
      }
      const path = m[2];
      const out: ReturnType<typeof walkPath> =
        path === undefined
          ? { ok: true, value: outputs.get(stepId) }
          : walkPath(outputs.get(stepId), path);
      // A present `undefined` (never produced by JSON) is treated as nothing, as before.
      if (out.ok && out.value !== undefined) return out.value;
      if (!out.ok && out.cause === "out-of-range")
        empty ??= {
          code: "upstream-empty",
          severity: "warn",
          message: `step "${node.stepId}" references "${stepId}" at path "${path ?? ""}": the upstream has no such row`,
        };
      else
        bad ??= {
          code: "unresolved-step-reference",
          severity: "error",
          message: `step "${node.stepId}" references "${stepId}" at path "${path ?? ""}", which resolves to nothing`,
        };
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    // `Object.fromEntries` writes with CreateDataProperty: an own `__proto__` argument stays an
    // own key instead of becoming the args object's prototype (an assignment would set it).
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  const args = visit(node.arguments) as Record<string, unknown>;
  const failure = bad ?? empty;
  return failure ? { ok: false, finding: failure } : { ok: true, args };
}
