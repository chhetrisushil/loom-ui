import {
  type ContainerRoleSpec,
  type Experience,
  type Finding,
  Operation,
  type ReadPolicy,
  containerRoleFindings,
  experienceNodeIds,
  genesis,
  isContainer,
  preservesNodes,
  replay,
  strictestClass,
  toolKey,
  toolsOf,
  validateExperience,
  walk,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import type { DataClass } from "@loom/classify";
import { requiredClass } from "./capabilityClass";
import { MAX_DRAFT_DEPTH, MAX_DRAFT_NODES } from "./contract";
import { readPlannerReach } from "./reach";
import type {
  CapabilityRef,
  ComposeInput,
  DecideContext,
  PlanPartial,
  PlanReport,
  PlanResult,
  Planner,
  PlannerUsage,
  ReviseInput,
} from "./spi";
import { snapshotUsage, totalUsage } from "./usage";

/**
 * Observes the decide scope behind a fixture's `ctx` (a fake that stamps identity, or a real loom
 * runtime's recorder). Supplying it opts the planner into the scope contract: its decider must
 * make at least one call through the scope, every call must carry `identity` (the deciding
 * execution), and a replay must make none. Omitting it means the scope contract is NOT checked.
 * `fixture.ctx` must be fresh (no decision already recorded): a ctx that already holds the
 * compose decision serves it without running the decider, which the kit reports as
 * `fixture-ctx-not-fresh`.
 */
export interface ScopeProbe {
  /** The identity every scope call must be stamped with. */
  readonly identity: string;
  /**
   * Every call made through the scope so far, with the identity it was stamped as. May return a
   * LIVE array that grows as calls are made: the kit reads `.length` at each checkpoint and never
   * holds the returned array across a planner call.
   */
  readonly calls: () => readonly { readonly identity: string; readonly toolId?: string }[];
}

/**
 * Opts the planner into the control-plane contract: a decide scope that REFUSES every call (an
 * authorisation denial, a budget refusal or an abort) must make `compose` REJECT with that error —
 * not return a (failed) plan the runtime would record as the decision, which a later grant could
 * never replace. Supplying it needs a second, FRESH recording context whose scope throws `error`.
 * Omitting it means the control-plane contract is NOT checked. When `streamProbe` is also given,
 * the same refusal is replayed with `onPartial` set: a denied STREAMED turn must reject too,
 * record nothing and emit no partial (it is one governed call, not a second path).
 */
export interface DenialProbe {
  /** A fresh recording context whose decide scope rejects every call with `error`. */
  readonly ctx: DecideContext;
  /** The refusal the scope raises; compose must reject with exactly it. */
  readonly error: unknown;
  /** How many decisions `ctx` has recorded; must stay 0. */
  readonly decisions: () => number;
}

/**
 * Opts the planner into the STREAMING contract (U1). The fixture's model must forward the
 * `onDelta` it is handed (through the decide scope, ADR 0119) and stream, as deltas, the SAME reply it
 * returns for `compose` (a model that
 * replies differently when streamed cannot be told from a planner that plans differently). Both
 * contexts must be FRESH recording contexts. Omitting it means streaming is NOT checked.
 *
 * Checked: partials arrive (at least one), each replays on the genesis and passes validation, a
 * partial carries no summary; the FINAL result equals the whole-reply result; a replay on the same
 * context calls no model and emits no partial; a cancelled turn (already aborted, or aborted from
 * inside the first partial) rejects and records nothing.
 */
export interface StreamProbe {
  /** A fresh recording context for the streamed compose and its replay. */
  readonly ctx: DecideContext;
  /** A fresh recording context for the cancelled turns. */
  readonly abortCtx: DecideContext;
  /** How many decisions `abortCtx` has recorded; must stay 0. */
  readonly abortDecisions: () => number;
}

export interface ConformanceFixture {
  readonly intent: ComposeInput["intent"];
  readonly catalog: ComposeInput["catalog"];
  readonly capabilities: readonly CapabilityRef[];
  readonly meta: Experience["meta"];
  readonly revision: {
    readonly text: string;
    readonly scopeNodeIds?: readonly string[];
    readonly expectRemoval?: boolean;
  };
  /** A RECORDING context: the kit calls compose twice and expects the second to be served. */
  readonly ctx: DecideContext;
  /** Counts model calls; when given, the kit asserts the second compose adds none. */
  readonly modelCalls?: () => number;
  readonly surface?: ComposeInput["surface"];
  /** See {@link ScopeProbe}. */
  readonly scopeProbe?: ScopeProbe;
  /** See {@link DenialProbe}. */
  readonly denialProbe?: DenialProbe;
  /**
   * Opts into the reach contract (loom L32): needs `scopeProbe` whose calls carry `toolId`. The
   * planner must DECLARE (`Symbol.for("loom.verify.reach")`, see `declarePlannerReach`) every
   * toolId it called through the scope during compose and revise, under `transient`; a missing
   * or short declaration is `reach-undeclared`. Omitting it means reach is NOT checked; asking for
   * it without a `scopeProbe` is `reach-unprobed` (a check with no input must not pass).
   */
  readonly checkReach?: boolean;
  /**
   * The host's read policy (core `ReadPolicy`). Under `undeclared: "deny"` a handle whose provider
   * calls a tool that is neither offered as a capability nor listed in its table is UNREADABLE for
   * every viewer; the kit warns (`handle-tool-undeclared`) when a composed or revised handle does.
   * Omitting it means this is not checked.
   */
  readonly readPolicy?: ReadPolicy;
  /** See {@link StreamProbe}. */
  readonly streamProbe?: StreamProbe;
  /**
   * The container roles offered to the planner (U15, `ComposeInput.containers`). Supplying them
   * also checks that every planner-owned container with one of these roles holds the children its
   * role needs. The structural bounds, container ownership and diff-not-recompose checks below
   * run whether or not any are offered.
   */
  readonly containers?: readonly ContainerRoleSpec[];
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });

/**
 * U15: what a plan may do to STRUCTURE. A composed or revised experience stays inside the bounds
 * the contract states (`MAX_DRAFT_DEPTH` levels below the root, `MAX_DRAFT_NODES` entries); every
 * container the planner inserts is stamped `owner: "planner"` (else the next revise finds it LOCKED
 * and can never edit what the planner itself made); and a role container holds what its role needs.
 */
function structureFindings(
  label: string,
  exp: Experience,
  roles: readonly ContainerRoleSpec[] | undefined,
  /** The ids the plan INSERTED; absent = every node (a compose builds the whole tree). */
  inserted?: ReadonlySet<string>
): Finding[] {
  const out: Finding[] = [];
  const mine = (id: string): boolean => inserted === undefined || inserted.has(id);
  // Judge only what the plan authored: an application's own containers (and how deep or how many
  // they are) are not the planner's to have bounded or stamped.
  const depthOf = new Map<string, number>();
  let deepest = 0;
  let count = 0;
  walk(exp.root, (n, parent) => {
    const d = parent === null ? 0 : (depthOf.get(parent.id) ?? 0) + 1;
    depthOf.set(n.id, d);
    if (parent === null || !mine(n.id)) return;
    count += 1;
    if (d > deepest) deepest = d;
    if (isContainer(n) && n.owner !== "planner")
      out.push(
        err(
          "container-not-owned",
          `${label} inserted container "${n.id}" without owner "planner"; a later revise would find it locked`
        )
      );
  });
  if (deepest > MAX_DRAFT_DEPTH)
    out.push(
      err(
        "nesting-too-deep",
        `${label} produced nesting ${deepest} levels deep; the bound is ${MAX_DRAFT_DEPTH}`
      )
    );
  if (count > MAX_DRAFT_NODES)
    out.push(
      err("too-many-nodes", `${label} produced ${count} entries; the bound is ${MAX_DRAFT_NODES}`)
    );
  if (roles !== undefined)
    out.push(...containerRoleFindings(exp.root, roles, { ownedBy: "planner" }));
  return out;
}

/** The ids of every node the ops insert (an `insertNode` carries its whole subtree). */
function insertedIds(ops: readonly Operation[]): Set<string> {
  const ids = new Set<string>();
  const visit = (op: Operation): void => {
    if (op.type === "prompt") for (const o of op.materialized) visit(o);
    else if (op.type === "insertNode")
      walk(op.node, (n) => {
        ids.add(n.id);
      });
  };
  for (const op of ops) visit(op);
  return ids;
}

/** A revise that removes and re-inserts the same id is a recompose wearing a diff's clothes. */
function recomposeFindings(ops: readonly Operation[]): Finding[] {
  const removed = new Set<string>();
  const inserted = new Set<string>();
  const visit = (op: Operation): void => {
    if (op.type === "prompt") for (const o of op.materialized) visit(o);
    else if (op.type === "removeNode") removed.add(op.nodeId);
    else if (op.type === "insertNode")
      walk(op.node, (n) => {
        inserted.add(n.id);
      });
  };
  for (const op of ops) visit(op);
  return [...removed]
    .filter((id) => inserted.has(id))
    .map((id) =>
      err(
        "revise-recomposed",
        `revise removed and re-inserted "${id}"; an unchanged node must not be touched, a moved one is a moveNode`
      )
    );
}

/**
 * U10b: classification is tool-level and fail-closed, so a node bound to a capability whose
 * declared `sensitivity` is `X` must carry a class at least `X` — whether or not the model proposed
 * one. Checks the nodes of `exp` against the capabilities the planner was offered (a handle whose
 * provider calls a tool no capability names is not judged; a capability declaring nothing demands
 * nothing). The declared class is the planner's to apply; the read-time floor in core
 * (`declaredToolClasses`) is the backstop, not a licence to skip it.
 */
function bindingClassFindings(
  label: string,
  exp: Experience,
  capabilities: readonly CapabilityRef[]
): Finding[] {
  const out: Finding[] = [];
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined) return;
    const spec = Object.hasOwn(exp.providers, n.binding.handle)
      ? exp.providers[n.binding.handle]
      : undefined;
    if (spec === undefined) return;
    const need = requiredClass(spec, capabilities);
    if (need !== undefined && strictestClass(n.binding.sensitivity, need) !== n.binding.sensitivity)
      out.push(
        err(
          "binding-class-below-capability",
          `${label}: node "${n.id}" is bound to a capability declared "${need}" but carries ${
            n.binding.sensitivity === undefined ? "no class" : `class "${n.binding.sensitivity}"`
          }: a bound node takes at least its capability's declared class`
        )
      );
  });
  return out;
}

/**
 * Under a bound `undeclared: "deny"` (`readPolicy`), a handle calling a tool neither offered as a
 * capability nor in the policy's table would be unreadable: the planner composed something no
 * viewer can see. A warning (the host may mean it), never an error.
 */
function undeclaredToolFindings(
  label: string,
  exp: Experience,
  capabilities: readonly CapabilityRef[],
  policy: ReadPolicy | undefined
): Finding[] {
  if (policy?.undeclared !== "deny") return [];
  const known = new Set<string>(capabilities.map((c) => toolKey(c)));
  for (const k of Object.keys(policy.declaredToolClasses ?? {})) known.add(k);
  const out: Finding[] = [];
  const seen = new Set<string>();
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined || seen.has(n.binding.handle)) return;
    const spec = Object.hasOwn(exp.providers, n.binding.handle)
      ? exp.providers[n.binding.handle]
      : undefined;
    if (spec === undefined) return;
    seen.add(n.binding.handle);
    const bad = toolsOf(spec).filter((k) => !known.has(k));
    if (bad.length > 0)
      out.push({
        code: "handle-tool-undeclared",
        severity: "warn",
        message: `${label}: handle "${n.binding.handle}" calls ${bad
          .map((k) => `"${k}"`)
          .join(
            ", "
          )}, offered as no capability and absent from the read policy's table under undeclared: "deny" — no viewer could read it`,
      });
  });
  return out;
}

/**
 * A `PlanReport` is what a caller stamps provenance from and what a prompt regression is measured
 * on, so it is part of the contract, not decoration. Three claims must hold or the numbers lie:
 * at least one attempt was made (a plan nobody attempted is not a plan), the model is NAMED, and
 * `firstAttemptValid` agrees with the attempts it summarises — it means "clean on the first call",
 * which is exactly "there was one attempt and every attempt parsed". When `usage` is present it
 * must be two non-negative integers and, if any attempt reports usage, their sum.
 */
/** One read of a `usage` field: absent, a validated fresh copy, or invalid (by kind, never content). */
type UsageRead =
  | { readonly state: "none" }
  | { readonly state: "valid"; readonly usage: PlannerUsage }
  | { readonly state: "invalid" };

/**
 * Reads `holder.usage` exactly ONCE, inside a guard, and snapshots it: a throwing or changing
 * getter cannot escape the kit or validate as one value and be compared as another. Callers use
 * only the returned snapshot afterwards. Never throws.
 */
function readUsage(holder: { readonly usage?: PlannerUsage }): UsageRead {
  let raw: unknown;
  try {
    raw = holder.usage;
  } catch {
    return { state: "invalid" };
  }
  if (raw === undefined) return { state: "none" };
  const usage = snapshotUsage(raw);
  return usage === undefined ? { state: "invalid" } : { state: "valid", usage };
}

/** `usage` is `report.usage` as already read once by {@link readUsage}; the report's own field is never re-read. */
function reportFindings(label: string, report: PlanReport, usage: UsageRead): Finding[] {
  const findings: Finding[] = [];
  if (report.attempts.length < 1)
    findings.push(err("report-invalid", `${label}: report.attempts is empty`));
  if (report.modelId === "")
    findings.push(err("report-invalid", `${label}: report.modelId is empty`));
  const clean = report.attempts.length === 1 && report.attempts.every((a) => a.parsed);
  if (report.firstAttemptValid !== clean)
    findings.push(
      err(
        "report-invalid",
        `${label}: firstAttemptValid is ${report.firstAttemptValid} but ${report.attempts.length} attempt(s) ${report.attempts.every((a) => a.parsed) ? "all parsed" : "did not all parse"}`
      )
    );
  // Each attempt's usage is read ONCE, inside a guard, and only a validated copy is summed: an
  // adapter controls these values, and the kit's contract is that it never throws. A refusal
  // names the attempt, never the value's content.
  const attemptUsages: { usage?: PlannerUsage }[] = [];
  let attemptsValid = true;
  report.attempts.forEach((a, i) => {
    const read = readUsage(a);
    if (read.state === "invalid") {
      attemptsValid = false;
      findings.push(
        err(
          "report-invalid",
          `${label}: attempt #${i} usage is not two non-negative integer token counts`
        )
      );
      return;
    }
    attemptUsages.push(read.state === "valid" ? { usage: read.usage } : {});
  });
  if (usage.state === "invalid")
    findings.push(
      err("report-invalid", `${label}: report.usage is not two non-negative integer token counts`)
    );
  else if (usage.state === "valid" && attemptsValid) {
    const total = usage.usage;
    const sum = totalUsage(attemptUsages);
    if (
      sum !== undefined &&
      (sum.inputTokens !== total.inputTokens || sum.outputTokens !== total.outputTokens)
    )
      findings.push(
        err(
          "report-invalid",
          `${label}: report.usage (${total.inputTokens}/${total.outputTokens}) is not the sum of its attempts' usage (${sum.inputTokens}/${sum.outputTokens})`
        )
      );
  }
  return findings;
}

/** A comparable key for one {@link readUsage} snapshot. Pure: it reads nothing from the planner. */
const usageKey = (u: UsageRead): string =>
  u.state === "valid" ? `${u.usage.inputTokens}/${u.usage.outputTokens}` : u.state;

/** True when calling into the planner itself threw instead of returning a `PlanResult`. */
async function safely<T>(
  label: string,
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; finding: Finding }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      finding: err(
        "planner-threw",
        `${label} threw instead of returning: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
}

/**
 * What ANY planner must hold (spec §7.1): ops not experiences; ops that validate; a revise that is
 * one prompt op whose primitives reproduce the same artifact; a decision that replays without the
 * model. Returns findings — a test asserts the list is empty. Never throws: a planner that throws
 * is reported as a `planner-threw` finding, same as any other misbehaviour.
 */
export async function checkPlannerConformance(
  planner: Planner,
  fx: ConformanceFixture
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const surface = fx.surface ?? "web";
  const g = genesis({ experienceId: "conformance", intent: fx.intent, meta: fx.meta });
  const composeInput: ComposeInput = {
    intent: fx.intent,
    catalog: fx.catalog,
    capabilities: fx.capabilities,
    surface,
    ...(fx.containers !== undefined && { containers: fx.containers }),
  };

  // With a probe, watch whether compose asked the ctx at all and whether the decider actually ran:
  // a planner that never calls `ctx.decide` ignores the scope (its fault); one that calls it but
  // whose decider never runs was served from a pre-populated ctx (a broken fixture).
  let decideCalled = 0;
  let deciderRan = 0;
  const ctx: DecideContext =
    fx.scopeProbe === undefined
      ? fx.ctx
      : {
          decide: (id, decider, opts) => {
            decideCalled += 1;
            return fx.ctx.decide(
              id,
              (scope) => {
                deciderRan += 1;
                return decider(scope);
              },
              opts
            );
          },
        };
  const firstAttempt = await safely("compose", () => planner.compose(composeInput, ctx));
  if (!firstAttempt.ok) return [firstAttempt.finding];
  const first = firstAttempt.value;
  const firstUsage = readUsage(first.report);
  findings.push(...reportFindings("compose", first.report, firstUsage));
  first.ops.forEach((op, i) => {
    if (!Operation.safeParse(op).success)
      findings.push(err("op-invalid", `compose op #${i} is not an Operation`));
  });
  // Only an INVALID OP stops the kit here: nothing below can replay ops that are not operations.
  // A `report-invalid` finding is collected and the rest of the contract is still checked.
  if (findings.some((f) => f.code === "op-invalid")) return findings;
  const composed = replay(g, first.ops);
  if (!composed.ok) return [err("compose-replay-failed", composed.finding.message)];
  const v = validateExperience(composed.value, fx.catalog, surface);
  if (!v.ok)
    findings.push(
      ...v.findings
        .filter((f) => f.severity === "error")
        .map((f) => ({ ...f, code: `compose-invalid:${f.code}` }))
    );
  if (!isContainer(composed.value.root) || composed.value.root.children.length === 0)
    findings.push(err("compose-empty", "compose produced no nodes"));

  findings.push(...structureFindings("compose", composed.value, fx.containers));
  findings.push(...bindingClassFindings("compose", composed.value, fx.capabilities));
  findings.push(
    ...undeclaredToolFindings("compose", composed.value, fx.capabilities, fx.readPolicy)
  );

  // U7: a summary is shown to a viewer only when cleared for its stamped class, so the planner
  // must stamp what the model read. The kit declares no `contextClass`, so a sampled capability of
  // unknown class means NO summary; a classified one means a stamp at least that strict.
  if (first.summary !== undefined) {
    const unknown = fx.capabilities.some(
      (c) => c.sampleOutput !== undefined && c.sensitivity === undefined
    );
    let need: DataClass | undefined;
    for (const c of fx.capabilities) need = strictestClass(need, c.sensitivity);
    if (unknown)
      findings.push(
        err(
          "summary-class-unsound",
          "compose kept a summary although an offered capability carries a sampleOutput of undeclared class and no contextClass was given"
        )
      );
    else if (need !== undefined && strictestClass(first.summaryClass, need) !== first.summaryClass)
      findings.push(
        err(
          "summary-class-unsound",
          `compose stamped summaryClass below the offered capabilities' class "${need}"`
        )
      );
  }

  const probe = fx.scopeProbe;
  // A COUNT, not the array: `calls()` may return a live array, and comparing a live array with
  // itself later would make `replay-recalled-scope` unable to fire.
  const scopeAfterFirst = probe?.calls().length ?? 0;
  if (probe !== undefined) {
    if (decideCalled === 0)
      findings.push(
        err(
          "scope-unused",
          "compose never called ctx.decide, so nothing it did ran through the decide scope as the deciding execution"
        )
      );
    else if (deciderRan === 0)
      findings.push(
        err(
          "fixture-ctx-not-fresh",
          "compose did not run its decider: fx.ctx already holds the decision, so the scope contract cannot be checked; pass a fresh recording context"
        )
      );
    else if (scopeAfterFirst === 0)
      findings.push(
        err(
          "scope-unused",
          "compose made no call through the decide scope; calls made outside it do not run as the deciding execution"
        )
      );
    if (probe.calls().some((c) => c.identity !== probe.identity))
      findings.push(
        err(
          "scope-identity-mismatch",
          `a scope call was stamped as other than the deciding execution "${probe.identity}"`
        )
      );
  }

  const denial = fx.denialProbe;
  if (denial !== undefined) {
    let outcome: { ok: true; value: PlanResult } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await planner.compose(composeInput, denial.ctx) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (outcome.ok)
      findings.push(
        err(
          "denial-swallowed",
          "compose returned a plan when the decide scope refused its call; a refusal must reject so the runtime records no decision"
        )
      );
    else if (outcome.error !== denial.error)
      findings.push(
        err(
          "denial-replaced",
          "compose rejected with an error other than the one the decide scope raised"
        )
      );
    if (denial.decisions() !== 0)
      findings.push(
        err(
          "denial-recorded",
          "a refused compose still recorded a decision, which a later grant can never replace"
        )
      );
    // The streamed turn is the same ONE governed call: asking for partials must not route the
    // model around the scope (the bypass that made a denied turn still call the model).
    if (fx.streamProbe !== undefined) {
      const seen: PlanPartial[] = [];
      let streamedOutcome: { ok: true } | { ok: false; error: unknown };
      try {
        await planner.compose(composeInput, denial.ctx, { onPartial: (p) => seen.push(p) });
        streamedOutcome = { ok: true };
      } catch (error) {
        streamedOutcome = { ok: false, error };
      }
      if (streamedOutcome.ok)
        findings.push(
          err(
            "stream-denial-swallowed",
            "a streamed compose (onPartial given) returned a plan when the decide scope refused its call: the streamed turn must go through the same governed call"
          )
        );
      else if (streamedOutcome.error !== denial.error)
        findings.push(
          err(
            "stream-denial-replaced",
            "a streamed compose rejected with an error other than the one the decide scope raised"
          )
        );
      if (denial.decisions() !== 0)
        findings.push(
          err("stream-denial-recorded", "a refused streamed compose recorded a decision")
        );
      if (seen.length > 0)
        findings.push(
          err("stream-denial-partials", "a refused streamed compose emitted a partial")
        );
    }
  }

  const before = fx.modelCalls?.() ?? 0;
  const secondAttempt = await safely("compose (second call)", () =>
    planner.compose(composeInput, ctx)
  );
  if (!secondAttempt.ok) return [...findings, secondAttempt.finding];
  const second = secondAttempt.value;
  if (JSON.stringify(second.ops) !== JSON.stringify(first.ops))
    findings.push(
      err(
        "replay-diverged",
        "a second compose on the same recording context returned different ops"
      )
    );
  if (fx.modelCalls !== undefined && fx.modelCalls() !== before)
    findings.push(
      err(
        "replay-recalled-model",
        "a second compose on the same recording context called the model again"
      )
    );
  if (probe !== undefined && probe.calls().length !== scopeAfterFirst)
    findings.push(
      err(
        "replay-recalled-scope",
        "a second compose on the same recording context made another call through the decide scope"
      )
    );
  // Usage is part of the DECIDED value: a replay that serves the ops but re-derives (or drops)
  // the report would give a caller two different token totals for one plan.
  const secondKey = usageKey(readUsage(second.report));
  const firstKey = usageKey(firstUsage);
  if (secondKey !== firstKey)
    findings.push(
      err(
        "usage-not-replayed",
        `a second compose on the same recording context reported usage ${secondKey}, the first ${firstKey}; record usage inside the decision`
      )
    );

  if (fx.streamProbe !== undefined)
    findings.push(
      ...(await streamingFindings(planner, composeInput, g, fx, fx.streamProbe, first))
    );

  const base = seal(composed.value);
  const scopeBeforeRevise = probe?.calls().length ?? 0;
  const reviseAttempt = await safely("revise", () =>
    planner.revise(
      {
        experience: base,
        request: {
          text: fx.revision.text,
          ...(fx.revision.scopeNodeIds && { scopeNodeIds: [...fx.revision.scopeNodeIds] }),
        },
        catalog: fx.catalog,
        capabilities: fx.capabilities,
        surface,
        ...(fx.containers !== undefined && { containers: fx.containers }),
      } satisfies ReviseInput,
      ctx
    )
  );
  if (!reviseAttempt.ok) return [...findings, reviseAttempt.finding];
  const revised = reviseAttempt.value;
  const reviseCalls = probe?.calls().slice(scopeBeforeRevise) ?? [];
  findings.push(...reportFindings("revise", revised.report, readUsage(revised.report)));
  // Identity only: whether revise must call the scope at all is the planner's business (a
  // deterministic revise legitimately decides without a model), but any call it DID make must
  // have run as the deciding execution.
  // Only the calls revise made: a compose mismatch is already reported on its own.
  if (probe !== undefined && reviseCalls.some((c) => c.identity !== probe.identity))
    findings.push(
      err(
        "scope-identity-mismatch",
        `a scope call made during revise was stamped as other than the deciding execution "${probe.identity}"`
      )
    );
  if (fx.checkReach === true) {
    if (probe === undefined)
      findings.push(
        err("reach-unprobed", "checkReach needs fx.scopeProbe: without it no tool call is observed")
      );
    else if (probe.calls().length > 0 && probe.calls().every((c) => typeof c.toolId !== "string"))
      findings.push(
        err(
          "reach-unprobed",
          "checkReach needs scopeProbe calls that carry toolId: none of the observed calls does"
        )
      );
    else {
      const called = [
        ...new Set(
          probe
            .calls()
            .map((c) => c.toolId)
            .filter((t): t is string => typeof t === "string")
        ),
      ];
      const declared = readPlannerReach(planner);
      const missing = called.filter((t) => !(declared?.transient ?? []).includes(t));
      if (missing.length > 0)
        findings.push(
          err(
            "reach-undeclared",
            declared === undefined
              ? `the planner called ${missing.map((t) => `"${t}"`).join(", ")} through the decide scope but carries no reach declaration`
              : `the planner called ${missing.map((t) => `"${t}"`).join(", ")} through the decide scope but its reach declaration does not list them under transient`
          )
        );
    }
  }
  if (revised.ops.length !== 1 || revised.ops[0]?.type !== "prompt") {
    findings.push(
      err(
        "revise-not-prompt",
        `revise returned ${revised.ops.length} op(s) of type(s) ${revised.ops.map((o) => o.type).join(",") || "none"}; expected exactly one prompt op`
      )
    );
    return findings;
  }
  const prompt = revised.ops[0];
  if (!Operation.safeParse(prompt).success)
    return [...findings, err("op-invalid", "revise's prompt op is not an Operation")];
  const viaPrompt = replay(base, [prompt]);
  const viaPrimitives = replay(base, prompt.materialized);
  if (!viaPrompt.ok) return [...findings, err("prompt-replay-failed", viaPrompt.finding.message)];
  if (!viaPrimitives.ok)
    return [...findings, err("prompt-replay-failed", viaPrimitives.finding.message)];
  findings.push(
    ...structureFindings("revise", viaPrompt.value, fx.containers, insertedIds([prompt]))
  );
  findings.push(...recomposeFindings(prompt.materialized));
  findings.push(...bindingClassFindings("revise", viaPrompt.value, fx.capabilities));
  findings.push(
    ...undeclaredToolFindings("revise", viaPrompt.value, fx.capabilities, fx.readPolicy)
  );
  if (seal(viaPrompt.value).versionHash !== seal(viaPrimitives.value).versionHash)
    findings.push(
      err(
        "prompt-replay-mismatch",
        "replaying the prompt op and replaying its materialized primitives yield different artifacts"
      )
    );
  const rv = validateExperience(viaPrompt.value, fx.catalog, surface);
  if (!rv.ok)
    findings.push(
      ...rv.findings
        .filter((f) => f.severity === "error")
        .map((f) => ({ ...f, code: `revise-invalid:${f.code}` }))
    );
  const identity = preservesNodes(experienceNodeIds(base), experienceNodeIds(viaPrompt.value));
  if (!identity.ok && fx.revision.expectRemoval !== true)
    findings.push(...identity.findings.map((f) => ({ ...f, code: "dropped-node" as const })));
  return findings;
}

/** The streaming contract (see {@link StreamProbe}). Never throws: a planner that throws is a finding. */
async function streamingFindings(
  planner: Planner,
  composeInput: ComposeInput,
  g: Experience,
  fx: ConformanceFixture,
  probe: StreamProbe,
  whole: PlanResult
): Promise<Finding[]> {
  const out: Finding[] = [];
  const surface = fx.surface ?? "web";
  const partials: PlanPartial[] = [];
  const streamed = await safely("compose (streamed)", () =>
    planner.compose(composeInput, probe.ctx, { onPartial: (p) => partials.push(p) })
  );
  if (!streamed.ok) return [streamed.finding];
  if (partials.length === 0)
    out.push(
      err(
        "stream-no-partials",
        "compose was given onPartial and a model that streams deltas but emitted no partial"
      )
    );
  partials.forEach((p, i) => {
    if (Object.hasOwn(p, "summary"))
      out.push(
        err(
          "stream-partial-summary",
          `partial #${i} carries a summary; only the final result may (U7)`
        )
      );
    const ops = p.ops;
    if (!Array.isArray(ops) || ops.some((o) => !Operation.safeParse(o).success)) {
      out.push(err("stream-partial-invalid", `partial #${i} is not a list of Operations`));
      return;
    }
    const applied = replay(g, ops);
    if (!applied.ok) {
      out.push(
        err("stream-partial-invalid", `partial #${i} does not apply: ${applied.finding.message}`)
      );
      return;
    }
    const bad = validateExperience(applied.value, fx.catalog, surface).findings.filter(
      (f) => f.severity === "error"
    );
    if (bad.length > 0)
      out.push(err("stream-partial-invalid", `partial #${i} fails validation: ${bad[0]?.code}`));
  });
  if (JSON.stringify(streamed.value.ops) !== JSON.stringify(whole.ops))
    out.push(
      err(
        "stream-final-differs",
        "the streamed compose returned different ops than the whole-reply compose for the same model output"
      )
    );
  // Replay: the recorded final is served; no model call, no partial.
  const calls = fx.modelCalls?.();
  const again: PlanPartial[] = [];
  const replayed = await safely("compose (streamed replay)", () =>
    planner.compose(composeInput, probe.ctx, { onPartial: (p) => again.push(p) })
  );
  if (!replayed.ok) return [...out, replayed.finding];
  if (again.length > 0 || (calls !== undefined && fx.modelCalls?.() !== calls))
    out.push(
      err(
        "stream-replay-recalled",
        "a replayed streamed compose called the model or emitted partials; a recorded decision is served whole"
      )
    );
  // Cancellation: rejects, records nothing — whether aborted before the call or from a partial.
  const pre = new AbortController();
  pre.abort();
  const cancelled: { label: string; run: () => Promise<PlanResult> }[] = [
    {
      label: "an already-aborted signal",
      run: () => planner.compose(composeInput, probe.abortCtx, { signal: pre.signal }),
    },
  ];
  if (partials.length > 0) {
    const mid = new AbortController();
    cancelled.push({
      label: "an abort from inside the first partial",
      run: () =>
        planner.compose(composeInput, probe.abortCtx, {
          signal: mid.signal,
          onPartial: () => mid.abort(),
        }),
    });
  }
  for (const c of cancelled) {
    const r = await safely(c.label, c.run);
    // `safely` turns a rejection into a finding: a rejection IS the right outcome here.
    if (r.ok)
      out.push(
        err(
          "stream-abort-ignored",
          `compose resolved with ${c.label}; a cancelled turn must reject`
        )
      );
  }
  if (probe.abortDecisions() !== 0)
    out.push(
      err(
        "stream-abort-recorded",
        "a cancelled turn recorded a decision, which would pin the cancellation as the plan"
      )
    );
  return out;
}
