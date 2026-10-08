import {
  type ContentRefTable,
  type ContractRegistry,
  type Finding,
  type MCPToolNode,
  type ProviderSpec,
  checkKindValue,
  contentRefEntry,
  hasKindContract,
  stepKind,
  toolKey,
} from "@loom-ui/core";
import { type TaintedValue, tainted } from "@loom/classify";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { type Shape, shapeOf } from "@loom/plugin-sandbox";
import { type ContentRefParamGate, checkContentRefs } from "./contentRefs";
import {
  DEFAULT_DATA_PROVIDERS,
  type DataProvider,
  type DataProviderRegistry,
} from "./dataProvider";
import type { TransientInvoker } from "./invoker";
import {
  type ArgumentHook,
  type LoadParams,
  pickParams,
  prepareArguments,
  providerParams,
} from "./params";
import { terminalSteps, topoWaves } from "./plan";
import {
  type ReshapeFailureKind,
  type ReshaperRegistry,
  outputShapeHashOf,
  reshape,
  safeStringify,
} from "./reshape";
import type { HandleLoadResult } from "./scheduler";

// ── Executing one provider ────────────────────────────────────────────────────
// The transient interpreter (ADRs 0060–0066): walk the graph in waves, invoke `mcp.invoke` per
// step with the pinned input-schema hash, reshape the terminal output, check it. Zero events on
// this path. Each step's arguments are prepared in a fixed order (params.ts): per-load params on
// the arguments the step declares overridable, relative-time tokens against ONE instant per
// call, `{{steps.…}}` templates, then the host's argument hook. The output is checked by its
// shape pin (`outputCheck` absent or "shape") or by the value contracts of the kinds it feeds
// ("contract"). A pin that drifts is REPORTED. By default the step fails and the handle goes
// stale; under `inputDrift: "report-and-proceed"` (a read-only viewer, which cannot persist a
// repair) the step is retried ONCE with the observed hash and the value is published — the drift
// is still returned, so the app can repair it. The durable repair is always the app's, and
// `remapOperation` (repair.ts) builds its operation. Output drift is never proceeded past.

export interface DriftRecord {
  /**
   * `input`: a step's input-schema pin moved — a pin move `remapOperation` can repair. `output`:
   * the reshaping no longer works for the tool's output — the reshaped value fails its shape pin
   * or value contract, OR the reshaping itself failed on it (`reshapeFailure`) — which only a
   * re-authored binding (a planner) can repair.
   */
  readonly kind: "input" | "output";
  readonly handle: string;
  /**
   * The step that drifted. Input drift: the step whose schema pin drifted (always present).
   * Output drift: the terminal step whose output was reshaped, set only when the graph has
   * exactly one terminal — with several terminals the raw sample is a record keyed by stepId, not
   * one step's output, so no single step identity applies.
   */
  readonly stepId?: string;
  readonly toolName?: string;
  /**
   * Input drift only, and ONLY for a step whose kind is not MCP: that kind (`step.kind`), so a
   * repairer knows `toolName` is a target of that kind, not an MCP tool. Absent for MCP — a record
   * for an MCP step is exactly what it was before kinds existed.
   */
  readonly providerKind?: string;
  readonly expected: string;
  readonly observed: string;
  /**
   * Output drift under `outputCheck: "contract"` only: the kind whose value contract the reshaped
   * value failed. `expected` is then `contract:<kind>` and `observed` the value's shape hash.
   */
  readonly contractKind?: string;
  /**
   * Output drift only, set when the RESHAPING ITSELF failed on the tool's output — and only when
   * the output demonstrably caused it (`reshapeFailureKind`): the failure's finding code
   * (`reshape-<channel>` / `reshape-failed`). `expected` is then `reshape` and `observed` that
   * same code, and there is no reshaped value, so `observedShape` is absent — the raw output
   * (`observedRawShape`, `observedSample`) is what a repair is authored against. Infrastructure
   * and transient failures (a `wallClock` limit, an untyped throw, a denial, a missing script or
   * reshaper, an abort) record no drift. The handle's status stays `error` (not `stale`) and the
   * public finding is unchanged; the drift is reported for repair (`onDrift`).
   */
  readonly reshapeFailure?: string;
  /** Beside `reshapeFailure`: WHY, typed — so a consumer can exclude a kind without parsing findings. */
  readonly reshapeFailureKind?: ReshapeFailureKind;
  /**
   * Output drift only: the structural shape loom's `shapeOf` saw of the RESHAPED value — the one
   * that failed the check, so it explains the mismatch. Absent when the value could not be walked,
   * and on a `reshapeFailure` (there is no reshaped value).
   */
  readonly observedShape?: Shape;
  /**
   * Output drift only: the structural shape of the RAW terminal output the reshaping was applied
   * to. A planner re-authors a `reshaping.scriptRef`, which is a path into the RAW output — so
   * without this a record carrying no sample gives it nothing to author a path against.
   * Absent when the raw value could not be walked.
   */
  readonly observedRawShape?: Shape;
  /**
   * Output drift only, and ONLY when `ExecuteOptions.captureSample` is set: the RAW terminal
   * output (the single terminal step's output, or the stepId-keyed record when there are several)
   * — NOT the reshaped value, because the planner consumes a sample as a capability's
   * `sampleOutput`, which is raw by contract and is what a `path` is authored against. ALWAYS
   * wrapped as untrusted content (ADR 0085): it is tool-authored and will be shown to a model.
   */
  readonly observedSample?: TaintedValue<unknown>;
}

export type ProviderOutcome =
  /** `drift` only when an input drift was proceeded past (`inputDrift: "report-and-proceed"`). */
  | { ok: true; value: unknown; findings: Finding[]; drift?: DriftRecord[] }
  | { ok: false; finding: Finding; drift: DriftRecord[]; findings: Finding[] };

/** What a load does on an input-schema drift: go stale (`report`), or record it and retry once with the observed pin. */
export type InputDriftMode = "report" | "report-and-proceed";

export interface ExecuteOptions {
  readonly invoker: TransientInvoker;
  readonly signal?: AbortSignal;
  readonly principal?: TransientInvokeOptions["principal"];
  /** Parallel steps per wave. Default 4. */
  readonly concurrency?: number;
  /** Attach the RAW terminal output to an output-drift record as a tainted sample. Default false. */
  readonly captureSample?: boolean;
  /**
   * The kinds the handle's bound nodes resolve to on the surface being hydrated (core's
   * `handleKinds`). Read only when the spec's `outputCheck` is `"contract"` — which REFUSES to run
   * without them: a contract check over no kinds would pass every value.
   */
  readonly kinds?: readonly string[];
  /**
   * The host's value contracts for kinds outside the framework's (`SemanticCatalog.valueContracts`).
   * A `"contract"` provider feeding a kind with neither contract is REFUSED (`output-contract-missing`).
   */
  readonly contracts?: ContractRegistry;
  /**
   * Per-load params: applied only to arguments a step declares `overridable`, never to a
   * `{{steps.…}}` template. A param no step declares is ignored with a `param-not-overridable` warn.
   */
  readonly params?: LoadParams;
  /** The instant relative-time tokens resolve against (epoch ms). Default: `Date.now()`, read once. */
  readonly now?: number;
  /** The host's last word on each step's arguments (after params, tokens, templates). */
  readonly argumentHook?: ArgumentHook;
  /**
   * The marked content-reference argument paths per tool (`toolKey`; core `contentRefPaths`, the
   * planner's `contentRefArgsFrom`). A step whose tool is listed is refused (`media-arg-literal`, the
   * call not made) when a marked argument holds a literal. Absent = nothing is marked.
   */
  readonly contentRefArgs?: ContentRefTable;
  /** The host's gate on a param that fills a marked argument; absent = every such param is refused. */
  readonly acceptContentRefParam?: ContentRefParamGate;
  /** On an input-schema drift. Default `"report"`. */
  readonly inputDrift?: InputDriftMode;
  /** Where `reshaping.engine: "Named"` looks its reshaper up. */
  readonly reshapers?: ReshaperRegistry;
  /**
   * The data-provider kinds this host composed (`defineDataProviders`). Default: MCP only, which is
   * every step of an experience written before kinds existed. A step naming a kind not in here
   * fails the whole provider as `provider-kind-unregistered`, before any step runs.
   */
  readonly providers?: DataProviderRegistry;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });

/** A step's invocation failed for a reason other than an input-schema drift. */
function stepFailure(node: MCPToolNode, e: unknown, signal: AbortSignal | undefined): Finding {
  if (e instanceof TypedFailure)
    return err(
      `tool-${e.channel}`,
      `step "${node.stepId}" (${node.toolName}) failed on channel ${e.channel}: ${safeStringify(e.payload)}`
    );
  if (signal?.aborted) return err("aborted", `step "${node.stepId}" aborted`);
  return err(
    "tool-failed",
    `step "${node.stepId}" (${node.toolName}) failed: ${e instanceof Error ? e.message : String(e)}`
  );
}

/**
 * The shapes an output-drift record carries. Neither value has necessarily been proved walkable
 * (the raw output never went through `shapeHash`): one too deep or too wide simply leaves its
 * field absent — a drift REPORT must never become a throw.
 */
function observedShapes(
  value: unknown,
  raw: unknown
): { observedShape?: Shape; observedRawShape?: Shape } {
  const out: { observedShape?: Shape; observedRawShape?: Shape } = {};
  try {
    out.observedShape = shapeOf(value);
  } catch {
    // unwalkable: leave absent
  }
  try {
    out.observedRawShape = shapeOf(raw);
  } catch {
    // unwalkable: leave absent
  }
  return out;
}

/** The raw output's shape alone — a failed reshaping has no reshaped value to walk. */
function observedRawShape(raw: unknown): { observedRawShape?: Shape } {
  try {
    return { observedRawShape: shapeOf(raw) };
  } catch {
    return {};
  }
}

/**
 * The first finding (graph order) when every step that failed ON ITS OWN failed with the same
 * one of `schema-drift` / `upstream-empty` — the rest were skipped as its dependents
 * (`dependency-failed`). `undefined` for anything else.
 */
function onlyFailure(
  steps: readonly MCPToolNode[],
  failed: ReadonlyMap<string, Finding>
): Finding | undefined {
  let first: Finding | undefined;
  for (const step of steps) {
    const f = failed.get(step.stepId);
    if (f === undefined || f.code === "dependency-failed") continue;
    if (f.code !== "schema-drift" && f.code !== "upstream-empty") return undefined;
    if (first !== undefined && f.code !== first.code) return undefined;
    first ??= f;
  }
  return first;
}

/** A published value; carries `drift` only when an input drift was proceeded past. */
const okOutcome = (value: unknown, findings: Finding[], drift: DriftRecord[]): ProviderOutcome =>
  drift.length > 0 ? { ok: true, value, findings, drift } : { ok: true, value, findings };

export async function executeProvider(
  spec: ProviderSpec,
  opts: ExecuteOptions
): Promise<ProviderOutcome> {
  const findings: Finding[] = [];
  const drift: DriftRecord[] = [];
  const steps = spec.executionGraph;
  if (steps.length === 0)
    return {
      ok: false,
      finding: err("empty-graph", `provider "${spec.handle}" has no steps`),
      drift,
      findings,
    };
  const { waves, cycle } = topoWaves(steps);
  if (cycle.length > 0)
    return {
      ok: false,
      finding: err(
        "graph-cycle",
        `provider "${spec.handle}" has a dependency cycle through ${cycle.join(", ")}`
      ),
      drift,
      findings,
    };

  const registry = opts.providers ?? DEFAULT_DATA_PROVIDERS;
  // Every kind is resolved BEFORE any step runs: an unregistered one must not leave the steps
  // before it having called their targets for an answer nobody will publish.
  const unregistered = [...new Set(steps.map(stepKind))].filter((k) => !registry.has(k)).sort();
  if (unregistered.length > 0)
    return {
      ok: false,
      finding: err(
        "provider-kind-unregistered",
        `provider "${spec.handle}" has steps of kind ${unregistered.map((k) => `"${k}"`).join(", ")}, which no data provider is registered for`
      ),
      drift,
      findings,
    };

  const now = opts.now ?? Date.now();
  const supplied: LoadParams = opts.params ?? {};
  const names = providerParams(spec);
  const declared = new Set(names);
  const undeclared = Object.keys(supplied)
    .filter((k) => !declared.has(k))
    .sort();
  // Only the params some step declares reach a step — and the argument hook. A hook that could
  // read an undeclared param could make the answer depend on a value no cache key carries.
  const params = pickParams(supplied, names);
  if (undeclared.length > 0)
    findings.push({
      code: "param-not-overridable",
      severity: "warn",
      message: `provider "${spec.handle}" declares no overridable argument named ${undeclared.map((k) => `"${k}"`).join(", ")}; ignored`,
    });

  const outputs = new Map<string, unknown>();
  const failed = new Map<string, Finding>();
  const warnings = new Map<string, Finding[]>();
  const warn = (stepId: string, f: Finding): void => {
    const list = warnings.get(stepId);
    if (list === undefined) warnings.set(stepId, [f]);
    else list.push(f);
  };
  const invokeOpts: TransientInvokeOptions = {
    label: "loom-ui.hydrate",
    ...(opts.signal && { signal: opts.signal }),
    ...(opts.principal && { principal: opts.principal }),
  };

  for (const wave of waves) {
    await mapLimit(wave, opts.concurrency ?? 4, async (node: MCPToolNode) => {
      if (opts.signal?.aborted) {
        failed.set(node.stepId, err("aborted", `step "${node.stepId}" aborted before it ran`));
        return;
      }
      if (node.dependsOn.some((d) => failed.has(d))) {
        failed.set(
          node.stepId,
          err("dependency-failed", `step "${node.stepId}" skipped: a dependency failed`)
        );
        return;
      }
      const contentRefs = contentRefEntry(opts.contentRefArgs, toolKey(node));
      const args = prepareArguments(node, outputs, {
        handle: spec.handle,
        params,
        now,
        ...(opts.argumentHook && { hook: opts.argumentHook }),
        ...(contentRefs !== undefined && {
          guard: (n, applied) =>
            checkContentRefs(n, applied, {
              handle: spec.handle,
              contentRefs,
              ...(opts.acceptContentRefParam && {
                acceptContentRefParam: opts.acceptContentRefParam,
              }),
            }),
        }),
      });
      if (!args.ok) {
        failed.set(node.stepId, args.finding);
        return;
      }
      for (const f of args.findings) warn(node.stepId, f);
      const dataProvider = registry.get(stepKind(node)) as DataProvider;
      const call = (expectedPin: string): Promise<unknown> =>
        dataProvider.invoke(
          { stepId: node.stepId, target: node.toolName, args: args.args, expectedPin },
          opts.invoker,
          invokeOpts
        );
      try {
        outputs.set(node.stepId, await call(node.toolSchemaHash));
      } catch (e) {
        if (!(e instanceof TypedFailure && e.channel === "schemaDrift")) {
          failed.set(node.stepId, stepFailure(node, e, opts.signal));
          return;
        }
        const observed = (e.payload as { observedHash?: string } | undefined)?.observedHash;
        drift.push({
          kind: "input",
          handle: spec.handle,
          stepId: node.stepId,
          toolName: node.toolName,
          ...(node.kind !== undefined && { providerKind: node.kind }),
          expected: node.toolSchemaHash,
          observed: observed ?? "",
        });
        const proceed =
          opts.inputDrift === "report-and-proceed" &&
          observed !== undefined &&
          observed !== "" &&
          observed !== node.toolSchemaHash;
        if (!proceed) {
          failed.set(
            node.stepId,
            err(
              "schema-drift",
              `step "${node.stepId}" (${node.toolName}) input schema drifted from ${node.toolSchemaHash} to ${observed ?? "?"}`
            )
          );
          return;
        }
        try {
          outputs.set(node.stepId, await call(observed));
          warn(node.stepId, {
            code: "schema-drift-proceeded",
            severity: "warn",
            message: `step "${node.stepId}" (${node.toolName}) input schema drifted from ${node.toolSchemaHash} to ${observed}; loaded once with the observed pin — the provider still needs its repair`,
          });
        } catch (retry) {
          failed.set(node.stepId, stepFailure(node, retry, opts.signal));
        }
      }
    });
  }

  // GRAPH order, not completion order: two independent steps that fail (or warn) in a race must
  // produce the same finding list every run, or the surface's text depends on which tool was slower.
  for (const step of steps) for (const f of warnings.get(step.stepId) ?? []) findings.push(f);
  for (const step of steps) {
    const f = failed.get(step.stepId);
    if (f) findings.push(f);
  }
  if (failed.size > 0) {
    // A provider that failed ONLY because of input drift (every step that failed on its own
    // drifted; the rest were skipped as its dependents) answers with the first drift in graph
    // order, so the surface says "waiting for a repair" rather than a generic failure. The same
    // rule for an EMPTY upstream (every step that failed on its own found no such row upstream,
    // `upstream-empty`): the answer is the first one, published `empty` (loom ADR 0100). Any
    // other failure alongside either — or the two mixed — keeps the generic `provider-failed`.
    const only = onlyFailure(steps, failed);
    if (only !== undefined) return { ok: false, finding: only, drift, findings };
    return {
      ok: false,
      finding: err(
        "provider-failed",
        `provider "${spec.handle}": ${failed.size} of ${steps.length} steps failed`
      ),
      drift,
      findings,
    };
  }

  const terminals = terminalSteps(steps);
  const raw =
    terminals.length === 1
      ? outputs.get((terminals[0] as MCPToolNode).stepId)
      : Object.fromEntries(terminals.map((t) => [t.stepId, outputs.get(t.stepId)]));

  const shaped = await reshape(spec.reshaping, raw, {
    invoker: opts.invoker,
    ...(opts.signal && { signal: opts.signal }),
    ...(opts.principal && { principal: opts.principal }),
    ...(opts.reshapers && { reshapers: opts.reshapers }),
  });
  if (!shaped.ok) {
    findings.push(shaped.finding);
    // Only a failure the OUTPUT demonstrably caused (typed by `reshape`, never read from a
    // message) is output drift a planner can repair — so, like a failed pin, the record carries
    // the raw output's shape and (under `captureSample`) its sample. Infrastructure and transient
    // failures carry no `failureKind`, and stay an error with no drift.
    if (shaped.failureKind !== undefined && opts.signal?.aborted !== true)
      drift.push({
        kind: "output",
        handle: spec.handle,
        expected: "reshape",
        observed: shaped.finding.code,
        reshapeFailure: shaped.finding.code,
        reshapeFailureKind: shaped.failureKind,
        ...(terminals.length === 1 && { stepId: (terminals[0] as MCPToolNode).stepId }),
        ...observedRawShape(raw),
        // An uncloneable output is not a data observation: no sample, even under captureSample.
        ...(opts.captureSample === true &&
          shaped.failureKind !== "uncloneable-output" && {
            observedSample: tainted(raw, `provider:${spec.handle}`),
          }),
      });
    return { ok: false, finding: shaped.finding, drift, findings };
  }

  if (spec.outputCheck === "contract")
    return checkContract(spec, shaped.value, raw, opts, drift, findings, terminals);
  if (spec.outputShapeHash === "") {
    findings.push({
      code: "output-shape-unpinned",
      severity: "warn",
      message: `provider "${spec.handle}" declares no outputShapeHash; the value is unchecked`,
    });
    return okOutcome(shaped.value, findings, drift);
  }
  // The shaped value is tool-authored: `shapeHash` refuses a nest past its depth cap (and any
  // value it cannot walk). An unhashable value is an UNVERIFIABLE one — reported as a failure,
  // never published as if the pin had matched, and never as a throw out of this total function.
  let observed: string;
  try {
    observed = outputShapeHashOf(shaped.value);
  } catch (e) {
    const f = err(
      "output-shape-unhashable",
      `provider "${spec.handle}" output cannot be shape-hashed, so the pinned ${spec.outputShapeHash} cannot be checked: ${e instanceof Error ? e.message : String(e)}`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  if (observed !== spec.outputShapeHash) {
    drift.push({
      kind: "output",
      handle: spec.handle,
      expected: spec.outputShapeHash,
      observed,
      ...(terminals.length === 1 && { stepId: (terminals[0] as MCPToolNode).stepId }),
      ...observedShapes(shaped.value, raw),
      ...(opts.captureSample === true && {
        observedSample: tainted(raw, `provider:${spec.handle}`),
      }),
    });
    const f = err(
      "output-shape-drift",
      `provider "${spec.handle}" output shape ${observed} differs from the pinned ${spec.outputShapeHash}`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  return okOutcome(shaped.value, findings, drift);
}

/**
 * `outputCheck: "contract"`: the reshaped value must satisfy the value contract of EVERY kind the
 * handle feeds (each widget renders the same value); kinds are checked in sorted order and the
 * first failure is the drift. `undefined` is refused explicitly — `checkKindValue` passes it as
 * "not hydrated yet", but a load that produced nothing is not a healthy value.
 */
function checkContract(
  spec: ProviderSpec,
  value: unknown,
  raw: unknown,
  opts: ExecuteOptions,
  drift: DriftRecord[],
  findings: Finding[],
  terminals: readonly MCPToolNode[]
): ProviderOutcome {
  const kinds = [...new Set(opts.kinds ?? [])].sort();
  if (kinds.length === 0) {
    const f = err(
      "output-contract-unbound",
      `provider "${spec.handle}" checks its output by contract, but no bound kinds were supplied; the value cannot be checked`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  // A contract check over a kind with NO contract passes every value, and a green check nobody
  // populated reads as coverage. So it is a refusal — and no drift record: reshaping the value
  // differently cannot repair a missing contract, which is the catalogue's to declare.
  const uncontracted = kinds.filter((k) => !hasKindContract(k, opts.contracts));
  if (uncontracted.length > 0) {
    const f = err(
      "output-contract-missing",
      `provider "${spec.handle}" checks its output by contract, but kind${uncontracted.length > 1 ? "s" : ""} ${uncontracted.map((k) => `"${k}"`).join(", ")} ${uncontracted.length > 1 ? "have" : "has"} no value contract (declare one in the catalogue's valueContracts); the value cannot be checked`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  for (const kind of kinds) {
    const r =
      value === undefined
        ? {
            ok: false as const,
            finding: err(
              "value-contract",
              `value for kind "${kind}" is undefined: the reshaping produced nothing`
            ),
          }
        : checkKindValue(kind, value, opts.contracts);
    if (r.ok) continue;
    let observed = "unhashable";
    try {
      observed = outputShapeHashOf(value);
    } catch {
      // Too deep to hash: the contract failure below is still reported.
    }
    drift.push({
      kind: "output",
      handle: spec.handle,
      expected: `contract:${kind}`,
      observed,
      contractKind: kind,
      ...(terminals.length === 1 && { stepId: (terminals[0] as MCPToolNode).stepId }),
      ...observedShapes(value, raw),
      ...(opts.captureSample === true && {
        observedSample: tainted(raw, `provider:${spec.handle}`),
      }),
    });
    const f = err("output-contract-drift", `provider "${spec.handle}": ${r.finding.message}`);
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  return okOutcome(value, findings, drift);
}

/**
 * What an outcome publishes — the ONE mapping both the in-process controller and `serveHandle`
 * use, so split and in-process hydration cannot disagree: a value is `ready` (carrying the first
 * warning, e.g. a proceeded drift); an `upstream-empty` failure is `empty` — checked FIRST, and
 * carrying no value (loom ADR 0100: a producer MUST clear the value beside `empty`); a failure
 * with drift is `stale` — unless its only drift is a failed reshaping (`reshapeFailure`), which
 * stays `error` as it always was — and any other failure `error`.
 */
export function outcomeResult(outcome: ProviderOutcome): HandleLoadResult {
  if (outcome.ok) {
    const warn = outcome.findings.find((f) => f.severity === "warn");
    return warn === undefined
      ? { state: "ready", value: outcome.value }
      : { state: "ready", value: outcome.value, finding: warn };
  }
  if (outcome.finding.code === "upstream-empty")
    return { state: "empty", finding: outcome.finding };
  const stale = outcome.drift.some((d) => d.reshapeFailure === undefined);
  return { state: stale ? "stale" : "error", finding: outcome.finding };
}
