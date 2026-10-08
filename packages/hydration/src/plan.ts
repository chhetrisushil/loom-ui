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

/**
 * Kahn's algorithm over step IDS, O(V + E): in-degree counts (distinct in-graph dependencies per
 * step) and a dependents list built once, then a FIFO of ids whose level never decreases. A step's
 * wave is 1 + the latest wave among its in-graph dependencies (0 with none); an id is placed at the
 * earliest wave any step carrying it is ready. Waves are then filled in the input's own order, so a
 * wave lists its steps exactly as the input does. This is the semantics of the original
 * re-filtering loop, pinned by an equivalence test: a step whose id another step already placed in
 * an EARLIER wave never runs (a duplicate id), and `cycle` lists — in input order — every step
 * whose id is never placed (a cycle, or anything behind one).
 */
export function topoWaves(nodes: readonly MCPToolNode[]): {
  waves: MCPToolNode[][];
  cycle: string[];
} {
  const ids = new Set(nodes.map((n) => n.stepId));
  const pending = new Array<number>(nodes.length);
  const readyAt = new Array<number>(nodes.length).fill(-1);
  const latestDep = new Array<number>(nodes.length).fill(-1);
  const dependents = new Map<string, number[]>();
  const placedAt = new Map<string, number>();
  const queue: string[] = [];
  const ready = (i: number, level: number): void => {
    readyAt[i] = level;
    const id = (nodes[i] as MCPToolNode).stepId;
    if (placedAt.has(id)) return;
    placedAt.set(id, level);
    queue.push(id);
  };
  nodes.forEach((n, i) => {
    const deps = new Set(n.dependsOn.filter((d) => ids.has(d)));
    pending[i] = deps.size;
    for (const d of deps) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [i]);
      else list.push(i);
    }
  });
  nodes.forEach((_, i) => {
    if (pending[i] === 0) ready(i, 0);
  });
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    const level = placedAt.get(id) as number;
    for (const i of dependents.get(id) ?? []) {
      latestDep[i] = Math.max(latestDep[i] as number, level);
      pending[i] = (pending[i] as number) - 1;
      if (pending[i] === 0) ready(i, (latestDep[i] as number) + 1);
    }
  }
  const waves: MCPToolNode[][] = [];
  const cycle: string[] = [];
  nodes.forEach((n, i) => {
    const at = placedAt.get(n.stepId);
    if (at === undefined) cycle.push(n.stepId);
    else if (readyAt[i] === at) {
      while (waves.length <= at) waves.push([]);
      (waves[at] as MCPToolNode[]).push(n);
    }
  });
  return { waves, cycle };
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

export const STEP_TEMPLATE = /^\{\{steps\.([A-Za-z0-9_-]+)\.output(?:\.(.+))?\}\}$/;

/**
 * Every step id `arguments` references through a `{{steps.<id>.output…}}` template, in first-seen
 * order, deduplicated — the same template grammar `resolveArguments` substitutes, so a planner can
 * check a graph it builds before it ships. At execution a reference resolves only against a step
 * in a STRICTLY EARLIER `topoWaves` wave than the referencing step; a step outside the graph, or in
 * the same or a later wave, has no output yet and is `unresolved-step-reference`.
 */
export function stepReferences(args: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      const m = STEP_TEMPLATE.exec(v);
      if (m) found.add(m[1] as string);
    } else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) visit(x);
  };
  visit(args);
  return [...found];
}

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
