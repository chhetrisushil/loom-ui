import {
  type Experience,
  type Finding,
  MAX_TREE_DEPTH,
  type ProviderSpec,
  type SemanticCatalog,
  type Surface,
  experienceHandles,
  handleKinds,
  treeDepth,
} from "@loom-ui/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { HydrationCache, normaliseKinds, specFingerprint } from "./cache";
import type { TransientInvoker } from "./invoker";
import { type HydrationStore, isReservedHandle } from "./projection";
import { type DriftRecord, executeProvider, outcomeResult } from "./provider";
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
// spec and — for a `"contract"` provider — the kinds it is checked against: a repaired provider
// re-runs exactly once, and a `stale` handle is not re-invoked while its question stands.

export interface DriftReport {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly handle: string;
  readonly spec: ProviderSpec;
  readonly drift: readonly DriftRecord[];
  readonly findings: readonly Finding[];
}

export interface ControllerOptions {
  readonly invoker: TransientInvoker;
  readonly store: HydrationStore;
  readonly clock?: () => number;
  /** Schedule `fn` after `ms`; returns a cancel. Default: setTimeout/clearTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  readonly batchWindowMs?: number;
  readonly concurrency?: number;
  readonly principal?: {
    readonly id: string;
    readonly chain?: TransientInvokeOptions["principal"];
  };
  readonly cache?: HydrationCache;
  readonly onDrift?: (report: DriftReport) => void;
  /**
   * Where `outputCheck: "contract"` providers get their kinds: every bound node resolved on this
   * surface through this catalogue (`handleKinds`). Without it a contract provider is an error.
   */
  readonly outputKinds?: { readonly catalog: SemanticCatalog; readonly surface: Surface };
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
  /** The kinds a `"contract"` provider is checked against; `undefined` for any other provider. */
  readonly kinds: readonly string[] | undefined;
  readonly experienceId: string;
  readonly versionHash: string;
}

type ProviderResult = HandleLoadResult & {
  readonly drift: readonly DriftRecord[];
  readonly findings: readonly Finding[];
};

export class HydrationController {
  private readonly cache: HydrationCache;
  private readonly sched: HandleScheduler<ProviderJob, undefined, ProviderResult>;
  private current: Experience | undefined;
  private kinds: ReadonlyMap<string, readonly string[]> = new Map();

  constructor(private readonly opts: ControllerOptions) {
    this.cache = opts.cache ?? new HydrationCache(opts.clock ?? Date.now);
    const principalId = opts.principal?.id;
    const variant = (job: ProviderJob) => (job.kinds === undefined ? {} : { kinds: job.kinds });
    this.sched = new HandleScheduler<ProviderJob, undefined, ProviderResult>(
      opts.store,
      {
        newGroup: () => undefined,
        run: (job, signal) => this.run(job, signal),
        cached: (job) => this.cache.get(job.spec, principalId, variant(job)),
        commit: (job, r) => {
          if (r.state === "ready") this.cache.set(job.spec, principalId, r.value, variant(job));
        },
        published: (job, r) => {
          if (r.state !== "stale") return;
          this.opts.onDrift?.({
            experienceId: job.experienceId,
            versionHash: job.versionHash,
            handle: job.handle,
            spec: job.spec,
            drift: r.drift,
            findings: r.findings,
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
    this.sched.retain(new Set(experienceHandles(next).map((h) => h.handle)));
    return this.bind(next);
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
    this.current = undefined;
  }

  private bind(exp: Experience): { findings: Finding[] } {
    if (treeDepth(exp.root) > MAX_TREE_DEPTH)
      return { findings: [tooDeep(exp.experienceId, MAX_TREE_DEPTH)] };
    this.current = exp;
    this.kinds =
      this.opts.outputKinds === undefined
        ? new Map()
        : handleKinds(exp, this.opts.outputKinds.catalog, this.opts.outputKinds.surface);
    const { jobs, findings, missing } = this.plan(exp);
    for (const m of missing)
      this.opts.store.setStatus(m.handle, { state: "error", finding: m.finding });
    this.sched.schedule(jobs);
    return { findings };
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
    for (const use of experienceHandles(exp)) {
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
      jobs.push({
        handle: use.handle,
        priority: use.priority,
        spec,
        // Only a contract provider's checked value is answerable to a kind; the cache key and
        // `executeProvider` ignore kinds for any other provider anyway.
        kinds: spec.outputCheck === "contract" ? kinds : undefined,
        experienceId: exp.experienceId,
        versionHash: exp.versionHash,
        fingerprint: loadFingerprint(spec, kinds),
      });
    }
    return { jobs, findings, missing };
  }

  private async run(job: ProviderJob, signal: AbortSignal): Promise<ProviderResult> {
    const outcome = await executeProvider(job.spec, {
      invoker: this.opts.invoker,
      signal,
      ...(job.kinds !== undefined && { kinds: job.kinds }),
      ...(this.opts.principal?.chain && { principal: this.opts.principal.chain }),
      ...(this.opts.concurrency !== undefined && { concurrency: this.opts.concurrency }),
    });
    return { ...outcomeResult(outcome), drift: outcome.drift ?? [], findings: outcome.findings };
  }
}
