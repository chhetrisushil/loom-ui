import type { Finding, MCPToolNode, ProviderSpec } from "@loom-ui/core";
import { canonicalJson, fnv1a64 } from "@loom/core";
import { resolveArguments } from "./plan";

// ── Per-load params and relative time ─────────────────────────────────────────
// A step opts arguments INTO being overridden (`MCPToolNode.overridable`). A load's params
// replace exactly those — never an argument holding a `{{steps.…}}` template (that value is
// another step's output; a param overwriting it would silently cut the graph), and never with a
// value that is itself a template (a param is a literal). Relative-time tokens (`$now`,
// `$now-7d`, `$now+1h`) resolve against ONE injected instant per load, so two steps asking for
// "the last day" in one pass ask the same question. Arguments are prepared in a fixed order:
// params → time tokens → templates → the host's argument hook.

export type LoadParams = Readonly<Record<string, unknown>>;

/** A time-range default a host may pass as `defaultParams`: the last 24 hours, relative to the load. */
export const DEFAULT_TIME_RANGE: LoadParams = Object.freeze({ from: "$now-24h", to: "$now" });

/** Token-shaped: `$now` not followed by a word character. `$nowcast` is an ordinary string. */
const TOKEN_LIKE = /^\$now(?![A-Za-z0-9_])/;
const TIME_TOKEN = /^\$now(?:([+-])(\d{1,9})([smhdw]))?$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const bad = (code: string, message: string): Finding => ({ code, severity: "error", message });
const note = (code: string, message: string): Finding => ({ code, severity: "warn", message });

/** `$now`, `$now-7d`, `$now+1h` (units s m h d w) as an ISO-8601 instant; `undefined` otherwise. */
export function resolveTimeToken(token: string, now: number): string | undefined {
  const m = TIME_TOKEN.exec(token);
  if (!m) return undefined;
  const offset =
    m[1] === undefined
      ? 0
      : (m[1] === "-" ? -1 : 1) * Number(m[2]) * (UNIT_MS[m[3] as string] as number);
  const at = new Date(now + offset);
  // Past ±8.64e15 ms a Date is invalid and `toISOString` would throw: refuse instead.
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** Every token-shaped string leaf is resolved, or the whole value is refused. Other leaves pass. */
export function resolveTimeTokens(
  value: unknown,
  now: number,
  where: string
): { ok: true; value: unknown } | { ok: false; finding: Finding } {
  let failure: Finding | undefined;
  const visit = (v: unknown): unknown => {
    if (failure) return v;
    if (typeof v === "string") {
      if (!TOKEN_LIKE.test(v)) return v;
      const iso = resolveTimeToken(v, now);
      if (iso !== undefined) return iso;
      failure = bad(
        "invalid-time-token",
        `${where}: "${v.slice(0, 64)}" is not a relative-time token ($now, $now-7d, $now+1h; units s m h d w)`
      );
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  const out = visit(value);
  return failure ? { ok: false, finding: failure } : { ok: true, value: out };
}

const STEP_REF = /\{\{\s*steps\./;
function containsStepTemplate(v: unknown): boolean {
  if (typeof v === "string") return STEP_REF.test(v);
  if (Array.isArray(v)) return v.some(containsStepTemplate);
  if (v !== null && typeof v === "object") return Object.values(v).some(containsStepTemplate);
  return false;
}

/** A plain object `canonicalJson` can represent (no NaN/±Infinity, bigint, function, over-deep nest). */
export function checkParams(params: unknown): Finding | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return bad("invalid-params", "params must be a plain object");
  try {
    canonicalJson(params);
    return undefined;
  } catch (e) {
    return bad(
      "invalid-params",
      `params cannot be represented as JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** Canonical identity of a param set (key order irrelevant); `""` for none. Throws only on what `checkParams` refuses. */
export function paramsKey(params: LoadParams): string {
  return Object.keys(params).length === 0 ? "" : fnv1a64(canonicalJson(params));
}

/** Every argument name any step of the provider declares overridable, sorted. */
export function providerParams(spec: ProviderSpec): string[] {
  const names = new Set<string>();
  for (const step of spec.executionGraph) for (const n of step.overridable ?? []) names.add(n);
  return [...names].sort();
}

/** The named params the set actually holds (own keys only), as a fresh object. */
export function pickParams(params: LoadParams, names: readonly string[]): LoadParams {
  return Object.fromEntries(
    names.filter((n) => Object.hasOwn(params, n)).map((n) => [n, params[n]])
  );
}

/** The params this provider can use: everything else cannot change its answer. */
export function relevantParams(spec: ProviderSpec, params: LoadParams): LoadParams {
  return pickParams(params, providerParams(spec));
}

export function applyParams(
  node: MCPToolNode,
  params: LoadParams
): { args: Record<string, unknown>; findings: Finding[] } {
  const names = node.overridable ?? [];
  const findings: Finding[] = [];
  if (names.length === 0) return { args: node.arguments, findings };
  // A Map, then `Object.fromEntries`: every write is CreateDataProperty, so an argument named
  // `__proto__` lands as an own key instead of setting a prototype.
  const args = new Map(Object.entries(node.arguments));
  for (const name of names) {
    if (!Object.hasOwn(params, name)) continue;
    if (containsStepTemplate(args.get(name))) {
      findings.push(
        note(
          "param-templated",
          `step "${node.stepId}": argument "${name}" is a {{steps.…}} template — another step's output — so no param replaces it`
        )
      );
      continue;
    }
    const value = params[name];
    if (containsStepTemplate(value)) {
      findings.push(
        note(
          "param-template-refused",
          `step "${node.stepId}": the param for "${name}" contains a {{steps.…}} template; a param is a literal, so it is not applied`
        )
      );
      continue;
    }
    args.set(name, value);
  }
  return { args: Object.fromEntries(args), findings };
}

export interface ArgumentHookContext {
  readonly handle: string;
  readonly stepId: string;
  readonly toolName: string;
  /**
   * The load's params as declared — under `executeProvider`, only those some step of the provider
   * declares overridable — with time tokens NOT resolved (`now` is the instant they resolve against).
   */
  readonly params: LoadParams;
  /** The instant this load resolved its time tokens against (epoch ms). */
  readonly now: number;
}

/** The host's last word on a step's arguments: after params, time tokens and templates; before the call. */
export type ArgumentHook = (
  args: Record<string, unknown>,
  ctx: ArgumentHookContext
) => Record<string, unknown>;

export interface PrepareContext {
  readonly handle: string;
  readonly params: LoadParams;
  readonly now: number;
  readonly hook?: ArgumentHook;
}

export function prepareArguments(
  node: MCPToolNode,
  outputs: ReadonlyMap<string, unknown>,
  ctx: PrepareContext
):
  | { ok: true; args: Record<string, unknown>; findings: Finding[] }
  | { ok: false; finding: Finding } {
  const applied = applyParams(node, ctx.params);
  const timed = resolveTimeTokens(applied.args, ctx.now, `step "${node.stepId}"`);
  if (!timed.ok) return timed;
  const templated = resolveArguments(
    { ...node, arguments: timed.value as Record<string, unknown> },
    outputs
  );
  if (!templated.ok) return templated;
  if (ctx.hook === undefined) return { ok: true, args: templated.args, findings: applied.findings };
  let hooked: unknown;
  try {
    hooked = ctx.hook(templated.args, {
      handle: ctx.handle,
      stepId: node.stepId,
      toolName: node.toolName,
      params: ctx.params,
      now: ctx.now,
    });
  } catch (e) {
    return {
      ok: false,
      finding: bad(
        "argument-hook-failed",
        `step "${node.stepId}": the argument hook threw: ${e instanceof Error ? e.message : String(e)}`
      ),
    };
  }
  if (hooked === null || typeof hooked !== "object" || Array.isArray(hooked))
    return {
      ok: false,
      finding: bad(
        "argument-hook-failed",
        `step "${node.stepId}": the argument hook returned ${hooked === null ? "null" : Array.isArray(hooked) ? "an array" : typeof hooked}, not an arguments object`
      ),
    };
  return { ok: true, args: hooked as Record<string, unknown>, findings: applied.findings };
}
