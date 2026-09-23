import type { Finding, MCPToolNode } from "@loom-ui/core";

// ── Graph scheduling and argument templating ──────────────────────────────────
// A ProviderSpec's executionGraph is a DAG of MCP steps. Steps run in topological WAVES (every
// step in a wave has all its in-graph dependencies in earlier waves). A dependency naming a step
// outside the graph is treated as satisfied — the planner may reference a step it pruned — and a
// cycle is reported, never looped over. Arguments may embed `{{steps.<id>.output.<path>}}`,
// resolved from an earlier step's raw output over OWN properties only: the path is model-written
// and walked over a tool response, so an unguarded walk is a prototype-pollution read.

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

/** Dotted path with optional `[i]` indices, own properties only. `undefined` when anything is missing. */
export function resolvePath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    const m = SEGMENT.exec(part);
    if (!m || cur === null || typeof cur !== "object") return undefined;
    const key = m[1] as string;
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    for (const idx of (m[2] ?? "").match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

export const STEP_TEMPLATE = /^\{\{steps\.([^.}]+)\.output(?:\.(.+))?\}\}$/;

export function resolveArguments(
  node: MCPToolNode,
  outputs: ReadonlyMap<string, unknown>
): { ok: true; args: Record<string, unknown> } | { ok: false; finding: Finding } {
  let failure: Finding | undefined;
  const visit = (v: unknown): unknown => {
    if (failure) return v;
    if (typeof v === "string") {
      const m = STEP_TEMPLATE.exec(v);
      if (!m) return v;
      const stepId = m[1] as string;
      if (!outputs.has(stepId)) {
        failure = {
          code: "unresolved-step-reference",
          severity: "error",
          message: `step "${node.stepId}" references "${stepId}", which has no output`,
        };
        return v;
      }
      const out = m[2] === undefined ? outputs.get(stepId) : resolvePath(outputs.get(stepId), m[2]);
      if (out === undefined) {
        failure = {
          code: "unresolved-step-reference",
          severity: "error",
          message: `step "${node.stepId}" references "${stepId}" at path "${m[2] ?? ""}", which resolves to nothing`,
        };
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(visit);
    // `Object.fromEntries` writes with CreateDataProperty: an own `__proto__` argument stays an
    // own key instead of becoming the args object's prototype (an assignment would set it).
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  const args = visit(node.arguments) as Record<string, unknown>;
  return failure ? { ok: false, finding: failure } : { ok: true, args };
}
