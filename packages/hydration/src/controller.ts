import {
  type Experience,
  type Finding,
  type HandleUse,
  MAX_TREE_DEPTH,
  type ProviderSpec,
  experienceHandles,
  treeDepth,
} from "@loom-ui/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { HydrationCache } from "./cache";
import type { TransientInvoker } from "./invoker";
import { type HydrationStore, isReservedHandle } from "./projection";
import { type DriftRecord, executeProvider } from "./provider";

// ── The controller ────────────────────────────────────────────────────────────
// Schedules the handles an experience binds — once each, at the highest priority any node asked
// for — and publishes results to the store. P0 now; P1 collected in a batching window; P2 held
// until the surface says the widget is visible. A recompose aborts loads the new experience no
// longer binds. Clock and timers are injected: scheduling is a pure function of calls made.

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
}

interface Load {
  readonly handle: string;
  readonly spec: ProviderSpec;
  readonly experienceId: string;
  readonly versionHash: string;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class HydrationController {
  private readonly cache: HydrationCache;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly batchWindowMs: number;
  private readonly inflight = new Map<string, AbortController>();
  private pending: Load[] = [];
  private cancelBatch: (() => void) | undefined;
  private readonly lazy = new Map<string, Load>();
  private current: Experience | undefined;

  constructor(private readonly opts: ControllerOptions) {
    this.cache = opts.cache ?? new HydrationCache(opts.clock ?? Date.now);
    this.setTimer = opts.setTimer ?? defaultTimer;
    this.batchWindowMs = opts.batchWindowMs ?? 50;
  }

  /** Bind an experience: schedule every handle it binds. Findings for handles that cannot load. */
  load(exp: Experience): { findings: Finding[] } {
    const findings: Finding[] = [];
    if (treeDepth(exp.root) > MAX_TREE_DEPTH) {
      findings.push({
        code: "tree-too-deep",
        severity: "error",
        message: `experience "${exp.experienceId}" exceeds MAX_TREE_DEPTH (${MAX_TREE_DEPTH})`,
      });
      return { findings };
    }
    this.current = exp;
    for (const use of experienceHandles(exp)) this.schedule(exp, use, findings);
    return { findings };
  }

  /** The surface reports a lazy (P2) widget entered the viewport. */
  markVisible(handle: string): void {
    const load = this.lazy.get(handle);
    if (!load) return;
    this.lazy.delete(handle);
    void this.start(load);
  }

  /** A new artifact replaces the current one: abort and drop unbound handles, keep the rest, load new ones. */
  recompose(next: Experience): { findings: Finding[] } {
    const nextHandles = new Set(experienceHandles(next).map((h) => h.handle));
    for (const handle of [
      ...this.inflight.keys(),
      ...this.lazy.keys(),
      ...this.pending.map((p) => p.handle),
      ...this.opts.store.handles(),
    ]) {
      if (nextHandles.has(handle)) continue;
      this.inflight.get(handle)?.abort();
      this.inflight.delete(handle);
      this.lazy.delete(handle);
      this.pending = this.pending.filter((p) => p.handle !== handle);
      if (this.opts.store.status(handle) !== undefined) this.opts.store.remove(handle);
    }
    return this.load(next);
  }

  /** Drop cached results (one handle or all) and reload the affected bound handles. */
  invalidate(handle?: string): void {
    this.cache.invalidate(handle);
    if (!this.current) return;
    for (const use of experienceHandles(this.current)) {
      if (handle !== undefined && use.handle !== handle) continue;
      const spec = this.specFor(this.current, use.handle);
      if (spec)
        void this.start({
          handle: use.handle,
          spec,
          experienceId: this.current.experienceId,
          versionHash: this.current.versionHash,
        });
    }
  }

  inFlight(): string[] {
    return [...this.inflight.keys()].sort();
  }

  dispose(): void {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.cancelBatch?.();
    this.cancelBatch = undefined;
    this.pending = [];
    this.lazy.clear();
  }

  private specFor(exp: Experience, handle: string): ProviderSpec | undefined {
    return Object.hasOwn(exp.providers, handle) ? exp.providers[handle] : undefined;
  }

  private schedule(exp: Experience, use: HandleUse, findings: Finding[]): void {
    if (isReservedHandle(use.handle)) {
      findings.push({
        code: "invalid-handle",
        severity: "error",
        message: `handle "${use.handle}" is reserved`,
      });
      return;
    }
    const spec = this.specFor(exp, use.handle);
    if (!spec) {
      const f: Finding = {
        code: "unknown-handle",
        severity: "error",
        message: `nodes ${use.nodeIds.join(", ")} bind "${use.handle}", which has no provider`,
      };
      findings.push(f);
      this.opts.store.setStatus(use.handle, { state: "error", finding: f });
      return;
    }
    const st = this.opts.store.status(use.handle)?.state;
    if (this.inflight.has(use.handle) || st === "ready" || st === "pending") return; // already loading or loaded for this store
    const load: Load = {
      handle: use.handle,
      spec,
      experienceId: exp.experienceId,
      versionHash: exp.versionHash,
    };
    if (use.priority === "P2") {
      this.lazy.set(use.handle, load);
      return;
    }
    this.lazy.delete(use.handle); // promoted out of P2: the lazy entry has a new owner (P0/P1 below)
    if (use.priority === "P0") {
      void this.start(load);
      return;
    }
    this.opts.store.setStatus(use.handle, { state: "pending" });
    this.pending.push(load);
    this.cancelBatch ??= this.setTimer(() => {
      this.cancelBatch = undefined;
      const batch = this.pending;
      this.pending = [];
      for (const l of batch) void this.start(l);
    }, this.batchWindowMs);
  }

  private async start(load: Load): Promise<void> {
    const { handle, spec } = load;
    const principalId = this.opts.principal?.id;
    const cached = this.cache.get(spec, principalId);
    if (cached) {
      this.inflight.delete(handle);
      this.opts.store.setValue(handle, cached.value, { state: "ready" });
      return;
    }
    if (this.inflight.has(handle)) return;
    const ac = new AbortController();
    this.inflight.set(handle, ac);
    this.opts.store.setStatus(handle, { state: "pending" });
    const outcome = await executeProvider(spec, {
      invoker: this.opts.invoker,
      signal: ac.signal,
      ...(this.opts.principal?.chain && { principal: this.opts.principal.chain }),
      ...(this.opts.concurrency !== undefined && { concurrency: this.opts.concurrency }),
    });
    if (this.inflight.get(handle) !== ac || ac.signal.aborted) return; // superseded or aborted: drop the late result
    this.inflight.delete(handle);
    if (outcome.ok) {
      this.cache.set(spec, principalId, outcome.value);
      const warn = outcome.findings.find((f) => f.severity === "warn");
      this.opts.store.setValue(handle, outcome.value, {
        state: "ready",
        ...(warn && { finding: warn }),
      });
      return;
    }
    if (outcome.drift.length > 0) {
      this.opts.store.setStatus(handle, { state: "stale", finding: outcome.finding });
      this.opts.onDrift?.({
        experienceId: load.experienceId,
        versionHash: load.versionHash,
        handle,
        spec,
        drift: outcome.drift,
        findings: outcome.findings,
      });
      return;
    }
    this.opts.store.setStatus(handle, { state: "error", finding: outcome.finding });
  }
}
