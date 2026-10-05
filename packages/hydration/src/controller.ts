import {
  type Experience,
  type Finding,
  MAX_TREE_DEPTH,
  type ProviderSpec,
  type SemanticCatalog,
  type Surface,
  type Viewer,
  experienceHandles,
  handleKinds,
  treeDepth,
} from "@loom-ui/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { HydrationCache, normaliseKinds, specFingerprint } from "./cache";
import type { TransientInvoker } from "./invoker";
import { limitInvoker, memoInvoker, signalInvoker } from "./invokers";
import {
  type ArgumentHook,
  type LoadParams,
  checkParams,
  paramsKey,
  relevantParams,
} from "./params";
import { type HydrationStore, isReservedHandle } from "./projection";
import { type DriftRecord, type InputDriftMode, executeProvider, outcomeResult } from "./provider";
import type { ReshaperRegistry } from "./reshape";
import { partitionByViewer, snapshotViewer } from "./restricted";
import {
  type HandleLoadResult,
  HandleScheduler,
  KEY_SEP,
  type ScheduledJob,
  defaultTimer,
  disposedFinding,
  tooDeep,
} from "./scheduler";

// ── The in-process controller ─────────────────────────────────────────────────
// Schedules the handles an experience binds (scheduler.ts: once per QUESTION, P0/P1/P2) and
// answers each through `executeProvider`, publishing to the store. A QUESTION is the provider
// spec, the load's params (defaults < global < handle-scoped, filtered to the arguments the
// provider declares overridable) and — for a `"contract"` provider — the kinds it is checked
// against: a repaired provider or a changed filter re-runs exactly once, an unrelated param
// change re-runs nothing, and a `stale` handle is not re-invoked while its question stands.
//
// Loads started together form a PASS: one instant for every relative-time token in it, and one
// memo, so an identical step (same tool, resolved args, schema pin, principal) shared by several
// providers runs once. The memo sits IN FRONT of the one controller-wide call cap
// (`maxConcurrentCalls`), so a memo hit never takes a slot; beneath both, every call is bound to
// the controller's lifetime, so `dispose` cancels each upstream call at once (a memo defers the
// cancel of a call only its own callers abandoned by a microtask — see invokers.ts). A lazy (P2)
// handle whose question changes (new params, `invalidate`) waits for its next `markVisible`,
// keeping its last value on screen until then.

export interface DriftReport {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly handle: string;
  readonly spec: ProviderSpec;
  readonly drift: readonly DriftRecord[];
  readonly findings: readonly Finding[];
  /** `true` when the load retried with the observed pin and published (`inputDrift: "report-and-proceed"`). */
  readonly proceeded: boolean;
}

export interface ControllerOptions {
  readonly invoker: TransientInvoker;
  readonly store: HydrationStore;
  /** Cache TTLs AND relative-time tokens run on this clock (read once per pass). Default `Date.now`. */
  readonly clock?: () => number;
  /** Schedule `fn` after `ms`; returns a cancel. Default: setTimeout/clearTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  readonly batchWindowMs?: number;
  /** Parallel steps per wave within ONE provider. Default 4. */
  readonly concurrency?: number;
  /** At most this many transient calls in flight across the WHOLE controller. Default: unbounded. */
  readonly maxConcurrentCalls?: number;
  readonly principal?: {
    readonly id: string;
    readonly chain?: TransientInvokeOptions["principal"];
  };
  readonly cache?: HydrationCache;
  /**
   * Who the data is for (`@loom-ui/core`'s `Viewer`). A handle bound by any node classified above
   * the viewer's clearance is never loaded: its provider is not invoked, nothing is cached for it,
   * and NOTHING is written to the store for it (no value, no status: a store projected to a client
   * must not even name it). SNAPSHOT at construction: later mutation of this object changes
   * nothing; a different viewer needs {@link HydrationController.setViewer} (or a new
   * controller). FAIL-CLOSED: absent = a viewer
   * with no clearance (and `load` reports one `viewer-not-supplied` warn if anything is
   * classified); unclassified handles are unaffected. Pass `{ clearance: "secret" }` for full access.
   */
  readonly viewer?: Viewer;
  readonly onDrift?: (report: DriftReport) => void;
  /**
   * Where `outputCheck: "contract"` providers get their kinds: every bound node resolved on this
   * surface through this catalogue (`handleKinds`). Without it a contract provider is an error.
   */
  readonly outputKinds?: { readonly catalog: SemanticCatalog; readonly surface: Surface };
  /** Params every load starts from (e.g. `DEFAULT_TIME_RANGE`); `setParams` layers over them. */
  readonly defaultParams?: LoadParams;
  /** On an input-schema drift: `"report"` (default) goes stale; `"report-and-proceed"` publishes. */
  readonly inputDrift?: InputDriftMode;
  /** The host's last word on each step's arguments (after params, time tokens, templates). */
  readonly argumentHook?: ArgumentHook;
  /** Where `Named` reshaping looks its reshapers up. */
  readonly reshapers?: ReshaperRegistry;
  /**
   * Attach the RAW terminal output to each output-drift record `onDrift` reports, as a tainted
   * sample (`DriftRecord.observedSample`) — what a planner repair pins against. Default false.
   * The same option `serveHandle` takes, so in-process and split drift reports carry the same.
   */
  readonly captureSample?: boolean;
}

/**
 * The question a load asks: the spec, and — for a `outputCheck: "contract"` provider only — the
 * kinds it is checked against. A `"shape"` (or unset) provider's fingerprint must NEVER fold in
 * kinds: its bound nodes' resolved kinds can change (a catalogue edit, a widened binding) without
 * the provider itself changing, and that must not abort an in-flight load or force a re-run.
 */
export function loadFingerprint(spec: ProviderSpec, kinds: readonly string[]): string {
  if (spec.outputCheck !== "contract" || kinds.length === 0) return specFingerprint(spec);
  // Normalised exactly as the cache key normalises them: a reordered or repeated kinds list is
  // the same question, and must not abort an in-flight load or force a re-run.
  return `${specFingerprint(spec)}${KEY_SEP}${normaliseKinds(kinds).join(",")}`;
}

interface ProviderJob extends ScheduledJob {
  readonly spec: ProviderSpec;
  /** Already filtered to the params this provider declares overridable (`relevantParams`). */
  readonly params: LoadParams;
  /** The kinds a `"contract"` provider is checked against; `undefined` for any other provider. */
  readonly kinds: readonly string[] | undefined;
  readonly experienceId: string;
  readonly versionHash: string;
}

/** Loads started together: one instant for their time tokens, one step memo for their calls. */
interface Pass {
  readonly now: number;
  readonly invoker: TransientInvoker;
}

type ProviderResult = HandleLoadResult & {
  readonly drift: readonly DriftRecord[];
  readonly findings: readonly Finding[];
};

export class HydrationController {
  private readonly cache: HydrationCache;
  private readonly clock: () => number;
  private readonly sched: HandleScheduler<ProviderJob, Pass, ProviderResult>;
  private current: Experience | undefined;
  private kinds: ReadonlyMap<string, readonly string[]> = new Map();
  private globalParams: LoadParams = {};
  private readonly scopedParams = new Map<string, LoadParams>();
  private readonly lifetime = new AbortController();

  /**
   * Throws `RangeError` for a `maxConcurrentCalls` that is not a positive integer, or
   * `defaultParams` that `checkParams` refuses.
   */
  /** The viewer, copied once at construction so a live mutation of the caller's object is inert. */
  private viewer: Viewer | undefined;

  constructor(private readonly opts: ControllerOptions) {
    this.viewer = snapshotViewer(opts.viewer);
    this.clock = opts.clock ?? Date.now;
    this.cache = opts.cache ?? new HydrationCache(this.clock);
    if (opts.defaultParams !== undefined) {
      const bad = checkParams(opts.defaultParams);
      if (bad) throw new RangeError(bad.message);
    }
    // ONE cap and ONE lifetime for the whole controller; a fresh memo per pass in front of them.
    const calls = signalInvoker(
      opts.maxConcurrentCalls === undefined
        ? opts.invoker
        : limitInvoker(opts.invoker, opts.maxConcurrentCalls),
      this.lifetime.signal
    );
    const principalId = opts.principal?.id;
    const variant = (job: ProviderJob) =>
      job.kinds === undefined ? { params: job.params } : { params: job.params, kinds: job.kinds };
    this.sched = new HandleScheduler<ProviderJob, Pass, ProviderResult>(
      opts.store,
      {
        newGroup: () => ({ now: this.clock(), invoker: memoInvoker(calls) }),
        run: (job, signal, pass) => this.run(job, signal, pass),
        cached: (job) => this.cache.get(job.spec, principalId, variant(job)),
        commit: (job, r) => {
          // Only `ready` is cached — an `empty` answer has no value (loom ADR 0100), so nothing
          // is stored. The scheduler still treats it as ANSWERED for the same question: it is
          // re-asked only when the question changes, on `invalidate`, or on a new bind (and then
          // never served from the cache). A result that proceeded past an input drift (`report-and-proceed`) is never cached:
          // the key does not carry the drift mode, so a controller sharing the cache under the
          // default (`report`) would be served it as a clean `ready` — no stale, no `onDrift`.
          if (r.state === "ready" && r.drift.length === 0)
            this.cache.set(job.spec, principalId, r.value, variant(job));
        },
        published: (job, r) => {
          if (r.drift.length === 0) return;
          this.opts.onDrift?.({
            experienceId: job.experienceId,
            versionHash: job.versionHash,
            handle: job.handle,
            spec: job.spec,
            drift: r.drift,
            findings: r.findings,
            // A proceeded input drift can sit beside an `empty` answer (the retried upstream had
            // no rows): still proceeded. `empty` itself never adds drift, so it alone never lands here.
            proceeded: r.state === "ready" || r.state === "empty",
          });
        },
      },
      opts.setTimer ?? defaultTimer,
      opts.batchWindowMs ?? 50
    );
  }

  /**
   * Bind an experience: schedule every handle it binds. Findings for handles that cannot load.
   * A second `load` while one experience is already bound IS a recompose — the previous
   * experience's handles are aborted and dropped rather than left published forever.
   */
  load(exp: Experience): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("load")] };
    if (this.current !== undefined) return this.recompose(exp);
    return this.bind(exp);
  }

  /**
   * Replace the viewer and re-plan the bound experience: a handle the new viewer may not see is
   * aborted and dropped (an in-flight result is discarded, a loaded value removed), one it newly
   * may see is scheduled. Before any `load` it only records the viewer.
   */
  setViewer(viewer: Viewer | undefined): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("setViewer")] };
    this.viewer = snapshotViewer(viewer);
    return this.current === undefined ? { findings: [] } : this.recompose(this.current);
  }

  /** The surface reports a lazy (P2) widget entered the viewport. */
  markVisible(handle: string): void {
    this.sched.markVisible(handle);
  }

  /** A new artifact replaces the current one: abort and drop unbound handles, keep the rest, load new ones. */
  recompose(next: Experience): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("recompose")] };
    // Before anything is aborted or dropped: a tree we refuse to bind must leave the CURRENT
    // one exactly as it was, not half-torn-down between two experiences.
    if (treeDepth(next.root) > MAX_TREE_DEPTH)
      return { findings: [tooDeep(next.experienceId, MAX_TREE_DEPTH)] };
    this.sched.retain(
      new Set(partitionByViewer(experienceHandles(next), this.viewer).allowed.map((h) => h.handle))
    );
    return this.bind(next);
  }

  /**
   * Replace the global params (no `scope.handle`) or one handle's scoped params, then re-ask
   * every bound handle whose question changed — only those, so a handle that ended on `error`
   * with an unchanged question is NOT retried here (`invalidate` retries it). `{}` clears.
   * Refused, with nothing changed, for params `checkParams` refuses or a reserved handle. A lazy
   * (P2) handle whose question changed waits for its next `markVisible`. Params scoped to a handle
   * the experience does not bind are kept only until the next bind, which forgets them.
   */
  setParams(params: LoadParams, scope: { readonly handle?: string } = {}): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("setParams")] };
    const bad = checkParams(params);
    if (bad) return { findings: [bad] };
    if (scope.handle !== undefined && isReservedHandle(scope.handle))
      return {
        findings: [
          {
            code: "invalid-handle",
            severity: "error",
            message: `handle "${scope.handle}" is reserved`,
          },
        ],
      };
    const before =
      this.current === undefined
        ? new Map<string, string>()
        : new Map(this.plan(this.current).jobs.map((j) => [j.handle, j.fingerprint]));
    // A copy (own enumerable keys only): a caller mutating its object later changes nothing.
    const copy: LoadParams = Object.fromEntries(Object.entries(params));
    if (scope.handle === undefined) this.globalParams = copy;
    else this.scopedParams.set(scope.handle, copy);
    if (this.current !== undefined)
      this.sched.schedule(
        this.plan(this.current).jobs.filter((j) => before.get(j.handle) !== j.fingerprint)
      );
    return { findings: [] };
  }

  /**
   * Drop cached results (one handle or all) and reload the affected bound handles. An in-flight
   * load answering the invalidated question is superseded; a lazy (P2) widget stays lazy.
   */
  invalidate(handle?: string): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("invalidate")] };
    this.cache.invalidate(handle);
    if (this.current === undefined) return { findings: [] };
    const jobs = this.plan(this.current).jobs;
    this.sched.reload(handle === undefined ? jobs : jobs.filter((j) => j.handle === handle));
    return { findings: [] };
  }

  inFlight(): string[] {
    return this.sched.inFlight();
  }

  /** Terminal: every in-flight load is aborted and reported, and nothing schedules again. */
  dispose(): void {
    this.sched.dispose();
    this.lifetime.abort();
    this.current = undefined;
    this.globalParams = {};
    this.scopedParams.clear();
  }

  private bind(exp: Experience): { findings: Finding[] } {
    if (treeDepth(exp.root) > MAX_TREE_DEPTH)
      return { findings: [tooDeep(exp.experienceId, MAX_TREE_DEPTH)] };
    this.current = exp;
    this.kinds =
      this.opts.outputKinds === undefined
        ? new Map()
        : handleKinds(exp, this.opts.outputKinds.catalog, this.opts.outputKinds.surface);
    // Scoped params outlive a bind only for handles it binds (set before a load, or kept across
    // a recompose); the rest are forgotten, so they never resurface on a later experience.
    const bound = new Set(experienceHandles(exp).map((h) => h.handle));
    for (const handle of [...this.scopedParams.keys()])
      if (!bound.has(handle)) this.scopedParams.delete(handle);
    const { jobs, findings, missing } = this.plan(exp);
    for (const m of missing)
      this.opts.store.setStatus(m.handle, { state: "error", finding: m.finding });
    // Refused handles: their status says so (and nothing else), and no job exists for them.
    const { restricted, advisory } = partitionByViewer(experienceHandles(exp), this.viewer);
    for (const r of restricted) {
      if (isReservedHandle(r.handle)) continue;
      // NOTHING is written for it: no value and no status, because a store projected to a client
      // would reveal the handle's name (and that it is restricted) through its status key.
      this.opts.store.remove(r.handle);
    }
    this.sched.schedule(jobs);
    return { findings: [...findings, ...advisory] };
  }

  /** Pure: the jobs `exp` asks for right now, and the handles that cannot load (with why). */
  private plan(exp: Experience): {
    jobs: ProviderJob[];
    findings: Finding[];
    missing: Array<{ handle: string; finding: Finding }>;
  } {
    const jobs: ProviderJob[] = [];
    const findings: Finding[] = [];
    const missing: Array<{ handle: string; finding: Finding }> = [];
    // A restricted handle is not a job: it never reaches the scheduler, the cache or a provider.
    for (const use of partitionByViewer(experienceHandles(exp), this.viewer).allowed) {
      if (isReservedHandle(use.handle)) {
        findings.push({
          code: "invalid-handle",
          severity: "error",
          message: `handle "${use.handle}" is reserved`,
        });
        continue;
      }
      const spec = Object.hasOwn(exp.providers, use.handle) ? exp.providers[use.handle] : undefined;
      if (spec === undefined) {
        const f: Finding = {
          code: "unknown-handle",
          severity: "error",
          message: `nodes ${use.nodeIds.join(", ")} bind "${use.handle}", which has no provider`,
        };
        findings.push(f);
        missing.push({ handle: use.handle, finding: f });
        continue;
      }
      const kinds = this.kinds.get(use.handle) ?? [];
      // Keyed on the params the provider can USE, never the raw bag: an unrelated param must
      // neither re-run the load nor split its cache entry.
      const params = relevantParams(spec, {
        ...this.opts.defaultParams,
        ...this.globalParams,
        ...this.scopedParams.get(use.handle),
      });
      jobs.push({
        handle: use.handle,
        priority: use.priority,
        spec,
        params,
        // Only a contract provider's checked value is answerable to a kind; the cache key and
        // `executeProvider` ignore kinds for any other provider anyway.
        kinds: spec.outputCheck === "contract" ? kinds : undefined,
        experienceId: exp.experienceId,
        versionHash: exp.versionHash,
        fingerprint: `${paramsKey(params)}${KEY_SEP}${loadFingerprint(spec, kinds)}`,
      });
    }
    return { jobs, findings, missing };
  }

  private async run(job: ProviderJob, signal: AbortSignal, pass: Pass): Promise<ProviderResult> {
    const outcome = await executeProvider(job.spec, {
      invoker: pass.invoker,
      signal,
      now: pass.now,
      params: job.params,
      ...(job.kinds !== undefined && { kinds: job.kinds }),
      ...(this.opts.principal?.chain && { principal: this.opts.principal.chain }),
      ...(this.opts.concurrency !== undefined && { concurrency: this.opts.concurrency }),
      ...(this.opts.inputDrift !== undefined && { inputDrift: this.opts.inputDrift }),
      ...(this.opts.argumentHook !== undefined && { argumentHook: this.opts.argumentHook }),
      ...(this.opts.reshapers !== undefined && { reshapers: this.opts.reshapers }),
      ...(this.opts.captureSample !== undefined && { captureSample: this.opts.captureSample }),
    });
    return { ...outcomeResult(outcome), drift: outcome.drift ?? [], findings: outcome.findings };
  }
}
