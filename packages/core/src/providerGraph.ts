import type { Finding } from "./experience";

// Provider-graph integrity, as pure findings. ZERO runtime imports: this module rides the
// zod-free `@loom-ui/core/browser` entry (`browserEntry.test.ts` fails on a byte of zod), so a
// client can preview the same verdict the server's `validateExperience` reaches.
//
// What is checked, per provider (iterated in sorted handle order, so the output is deterministic):
//   - `provider-handle-mismatch`: the key it is stored under differs from `spec.handle`.
//   - `provider-step-duplicate`: two steps share a `stepId` (a template names a step by id).
//   - `provider-dependency-unknown`: a `dependsOn` names a step the graph does not have.
//   - `provider-cycle`: steps that can never run because of a dependency cycle (or sit behind one).
//   - `provider-template-unknown-step`: an `arguments` value `{{steps.<id>.output…}}` names a step
//     that is not in the graph, or that does not run in a STRICTLY EARLIER wave than the step
//     holding it (a self-reference included) — hydration resolves a template only against
//     earlier-wave output, so anything else is `unresolved-step-reference` at load.
//
// All are errors except `provider-dependency-unknown`, a WARN: hydration's scheduler treats a
// `dependsOn` naming a step outside the graph as SATISFIED ("the planner may reference a step it
// pruned"; `hydration/src/plan.ts`), so such a plan still runs — an error here would reject plans
// that work. Findings per code are capped per provider (`FINDING_CAP` named, then one aggregate
// "and N more" finding with the exact count), so a hostile graph yields a bounded report. Cost is O(V + E + size of arguments) per provider: Kahn's algorithm for
// levels (the cycle test and the wave test are one pass) and an ITERATIVE walk of each step's
// `arguments`; nothing recurses, so a graph or an argument tree of any depth cannot overflow the
// stack.

/** The part of a step this module reads. Structural, so a caller's own type fits. */
export interface GraphStep {
  readonly stepId: string;
  readonly dependsOn?: readonly string[] | undefined;
  readonly arguments?: unknown;
}

/** The part of a provider this module reads. */
export interface GraphProvider {
  readonly handle: string;
  readonly executionGraph: readonly GraphStep[];
}

// The grammar hydration resolves (`STEP_TEMPLATE` in `@loom-ui/hydration`): a WHOLE string.
const STEP_TEMPLATE = /^\{\{steps\.([A-Za-z0-9_-]+)\.output(?:\.(.+))?\}\}$/;

/** Names listed in a message; the count is always exact, the list is capped. */
const LIST_CAP = 8;
const listIds = (ids: readonly string[]): string =>
  ids.length <= LIST_CAP
    ? ids.map((i) => `"${i}"`).join(", ")
    : `${ids
        .slice(0, LIST_CAP)
        .map((i) => `"${i}"`)
        .join(", ")} and ${ids.length - LIST_CAP} more`;

const FINDING_CAP = 8;
/** First FINDING_CAP findings, then one aggregate carrying the exact remainder. Deterministic. */
function capped(
  items: readonly Finding[],
  code: string,
  where: string,
  severity: Finding["severity"]
): Finding[] {
  if (items.length <= FINDING_CAP) return [...items];
  const rest = items.length - FINDING_CAP;
  return [
    ...items.slice(0, FINDING_CAP),
    {
      code,
      severity,
      message: `${where}: and ${rest} more ${code} finding(s) not listed (${items.length} in total)`,
    },
  ];
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });

/** Step ids `args` references through whole-string templates, first-seen order, deduplicated. Iterative. */
function templateRefs(args: unknown): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [args];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      const m = STEP_TEMPLATE.exec(v);
      if (m) found.add(m[1] as string);
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (v !== null && typeof v === "object") {
      const vals = Object.values(v);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
  return [...found];
}

function graphFindings(handle: string, steps: readonly GraphStep[]): Finding[] {
  const out: Finding[] = [];
  const where = `provider "${handle}"`;
  const index = new Map<string, number>(); // first step carrying each id
  const dupes = new Set<string>();
  steps.forEach((s, i) => {
    if (index.has(s.stepId)) dupes.add(s.stepId);
    else index.set(s.stepId, i);
  });
  out.push(
    ...capped(
      [...dupes].map((id) =>
        err("provider-step-duplicate", `${where}: step id "${id}" appears more than once`)
      ),
      "provider-step-duplicate",
      where,
      "error"
    )
  );

  // Kahn over distinct ids; a duplicate id's dependencies are unioned onto the one id.
  // (A duplicate id's level here — dependencies unioned — differs from the runtime's earliest-level
  // placement, but that is moot: the graph is already a `provider-step-duplicate` error.)
  const unknownDeps: Finding[] = [];
  const deps = new Map<string, Set<string>>();
  for (const s of steps) {
    let set = deps.get(s.stepId);
    if (set === undefined) {
      set = new Set();
      deps.set(s.stepId, set);
    }
    for (const d of s.dependsOn ?? []) {
      if (index.has(d)) set.add(d);
      else
        unknownDeps.push({
          code: "provider-dependency-unknown",
          severity: "warn",
          message: `${where}: step "${s.stepId}" depends on "${d}", which is not a step of this graph (hydration treats it as satisfied, so the plan still runs)`,
        });
    }
  }
  out.push(...capped(unknownDeps, "provider-dependency-unknown", where, "warn"));
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const queue: string[] = [];
  const level = new Map<string, number>();
  for (const [id, set] of deps) {
    pending.set(id, set.size);
    for (const d of set) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [id]);
      else list.push(id);
    }
    if (set.size === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    const lv = level.get(id) as number;
    for (const next of dependents.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, lv + 1));
      const p = (pending.get(next) as number) - 1;
      pending.set(next, p);
      if (p === 0) queue.push(next);
    }
  }
  const stuck = [...deps.keys()].filter((id) => !level.has(id) || (pending.get(id) as number) > 0);
  if (stuck.length > 0)
    out.push(
      err(
        "provider-cycle",
        `${where}: the execution graph has a dependency cycle — ${stuck.length} step(s) can never run (the cycle or a step behind it): ${listIds(stuck)}`
      )
    );

  const stuckSet = new Set(stuck);
  const tplFindings: Finding[] = [];
  for (const s of steps) {
    if (stuckSet.has(s.stepId)) continue; // its wave is undefined; the cycle is already reported
    const own = level.get(s.stepId) as number;
    for (const ref of templateRefs(s.arguments)) {
      const refLevel = level.get(ref);
      if (refLevel === undefined && stuckSet.has(ref)) continue; // behind a reported cycle
      if (refLevel === undefined)
        tplFindings.push(
          err(
            "provider-template-unknown-step",
            `${where}: step "${s.stepId}" references "${ref}" in a {{steps…}} template, but the graph has no such step`
          )
        );
      else if (refLevel >= own)
        tplFindings.push(
          err(
            "provider-template-unknown-step",
            `${where}: step "${s.stepId}" references "${ref}" in a {{steps…}} template, but "${ref}" does not run before it — add it to dependsOn (directly or through another step)`
          )
        );
    }
  }
  out.push(...capped(tplFindings, "provider-template-unknown-step", where, "error"));
  return out;
}

/**
 * The graph findings of a provider table, deterministic (sorted handles; within a provider the
 * codes in the order listed above). Pure and total: it never throws on a malformed table.
 */
export function providerGraphFindings(
  providers: Readonly<Record<string, GraphProvider>>
): Finding[] {
  const out: Finding[] = [];
  for (const key of Object.keys(providers).sort()) {
    const spec = providers[key] as GraphProvider;
    if (spec.handle !== key)
      out.push(
        err(
          "provider-handle-mismatch",
          `provider is stored under "${key}" but declares handle "${spec.handle}"`
        )
      );
    out.push(...graphFindings(key, spec.executionGraph));
  }
  return out;
}
