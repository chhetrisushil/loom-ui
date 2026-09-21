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
import { HydrationCache, specFingerprint } from "./cache";
import type { TransientInvoker } from "./invoker";
import { type HydrationStore, isReservedHandle } from "./projection";
import { type DriftRecord, executeProvider } from "./provider";

// ── The controller ────────────────────────────────────────────────────────────
// Schedules the handles an experience binds — once each, at the highest priority any node asked
// for — and publishes results to the store. P0 now; P1 collected in a batching window; P2 held
// until the surface says the widget is visible. A recompose aborts loads the new experience no
// longer binds. Clock and timers are injected: scheduling is a pure function of calls made.
//
// "Once each" is per SPEC, not per handle name: `loaded` remembers the fingerprint of the spec a
// handle was last started with, so a repaired provider (a remapped schema pin) re-runs exactly
// once while an unchanged one — including a `stale` one whose drift is still unrepaired — is not
// re-invoked on every load.
//
// Nothing here ever leaks a rejection: `start` is the only async path and it publishes its own
// failures as an `error` status. A surface that loses one handle keeps the rest of its data.

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

const tooDeep = (exp: Experience): Finding => ({
  code: "tree-too-deep",
  severity: "error",
  message: `experience "${exp.experienceId}" exceeds MAX_TREE_DEPTH (${MAX_TREE_DEPTH})`,
});

const disposedFinding = (what: string): Finding => ({
  code: "disposed",
  severity: "error",
  message: `the hydration controller is disposed; ${what} does nothing`,
});

export class HydrationController {
  private readonly cache: HydrationCache;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly batchWindowMs: number;
  private readonly inflight = new Map<string, AbortController>();
  private pending: Load[] = [];
  private cancelBatch: (() => void) | undefined;
  private readonly lazy = new Map<string, Load>();
  /** handle → fingerprint of the spec it was last STARTED with. Pruned with the handle. */
  private readonly loaded = new Map<string, string>();
  private current: Experience | undefined;
  private disposed = false;

  constructor(private readonly opts: ControllerOptions) {
    this.cache = opts.cache ?? new HydrationCache(opts.clock ?? Date.now);
    this.setTimer = opts.setTimer ?? defaultTimer;
    this.batchWindowMs = opts.batchWindowMs ?? 50;
  }

  /**
   * Bind an experience: schedule every handle it binds. Findings for handles that cannot load.
   * A second `load` while one experience is already bound IS a recompose — the previous
   * experience's handles are aborted and dropped rather than left published forever.
   */
  load(exp: Experience): { findings: Finding[] } {
    if (this.disposed) return { findings: [disposedFinding("load")] };
    if (this.current !== undefined) return this.recompose(exp);
    return this.bind(exp);
  }

  /** The surface reports a lazy (P2) widget entered the viewport. */
  markVisible(handle: string): void {
    if (this.disposed) return;
    const load = this.lazy.get(handle);
    if (!load) return;
    this.lazy.delete(handle);
    this.start(load).catch(() => {});
  }

  /** A new artifact replaces the current one: abort and drop unbound handles, keep the rest, load new ones. */
  recompose(next: Experience): { findings: Finding[] } {
    if (this.disposed) return { findings: [disposedFinding("recompose")] };
    // Before anything is aborted or dropped: a tree we refuse to bind must leave the CURRENT
    // one exactly as it was, not half-torn-down between two experiences.
    if (treeDepth(next.root) > MAX_TREE_DEPTH) return { findings: [tooDeep(next)] };
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
      this.loaded.delete(handle);
      this.pending = this.pending.filter((p) => p.handle !== handle);
      if (this.opts.store.status(handle) !== undefined) this.opts.store.remove(handle);
    }
    return this.bind(next);
  }

  /** Drop cached results (one handle or all) and reload the affected bound handles. */
  invalidate(handle?: string): { findings: Finding[] } {
    if (this.disposed) return { findings: [disposedFinding("invalidate")] };
    this.cache.invalidate(handle);
    if (!this.current) return { findings: [] };
    for (const use of experienceHandles(this.current)) {
      if (handle !== undefined && use.handle !== handle) continue;
      const spec = this.specFor(this.current, use.handle);
      if (!spec) continue;
      // An in-flight load is answering the question we just invalidated: cancel it, or its late
      // result publishes the value `invalidate` was called to get rid of.
      this.inflight.get(use.handle)?.abort();
      this.inflight.delete(use.handle);
      const load: Load = {
        handle: use.handle,
        spec,
        experienceId: this.current.experienceId,
        versionHash: this.current.versionHash,
      };
      // A lazy widget stays lazy: invalidating must not fetch data for something off-screen.
      // The next `markVisible` picks the re-queued load up; the status is left as it is, so the
      // widget keeps showing its last value until it is actually looked at.
      if (use.priority === "P2") {
        this.lazy.set(use.handle, load);
        continue;
      }
      this.start(load).catch(() => {});
    }
    return { findings: [] };
  }

  inFlight(): string[] {
    return [...this.inflight.keys()].sort();
  }

  /** Terminal: every in-flight load is aborted and reported, and nothing schedules again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [handle, ac] of this.inflight) {
      ac.abort();
      // The widget must not sit on a spinner forever because its controller went away.
      this.opts.store.setStatus(handle, {
        state: "error",
        finding: {
          code: "disposed",
          severity: "error",
          message: `hydration for "${handle}" was disposed while in flight`,
        },
      });
    }
    this.inflight.clear();
    this.cancelBatch?.();
    this.cancelBatch = undefined;
    for (const load of this.pending) {
      // Already published `pending` by `schedule`; leaving it there would spin the widget
      // forever waiting on a batch timer that just got cancelled. `this.lazy` entries are left
      // alone: they were never published, so there is no status to terminate.
      this.opts.store.setStatus(load.handle, {
        state: "error",
        finding: {
          code: "disposed",
          severity: "error",
          message: `hydration for "${load.handle}" was disposed while queued`,
        },
      });
    }
    this.pending = [];
    this.lazy.clear();
    this.loaded.clear();
    this.current = undefined;
  }

  private bind(exp: Experience): { findings: Finding[] } {
    const findings: Finding[] = [];
    if (treeDepth(exp.root) > MAX_TREE_DEPTH) {
      findings.push(tooDeep(exp));
      return { findings };
    }
    this.current = exp;
    for (const use of experienceHandles(exp)) this.schedule(exp, use, findings);
    return { findings };
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
    const fp = specFingerprint(spec);
    const st = this.opts.store.status(use.handle)?.state;
    if (this.loaded.get(use.handle) === fp) {
      // Same question, already asked: loading, loaded, or drifted-and-awaiting-repair.
      if (st === "ready" || st === "pending" || st === "stale") return;
    } else {
      // A different spec for this handle (repaired pin, new tool, new reshaping): whatever is in
      // flight is answering the OLD question. Cancel it and ask the new one.
      this.inflight.get(use.handle)?.abort();
      this.inflight.delete(use.handle);
    }
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
      this.start(load).catch(() => {});
      return;
    }
    this.opts.store.setStatus(use.handle, { state: "pending" });
    this.pending.push(load);
    this.cancelBatch ??= this.setTimer(() => {
      this.cancelBatch = undefined;
      const batch = this.pending;
      this.pending = [];
      for (const l of batch) this.start(l).catch(() => {});
    }, this.batchWindowMs);
  }

  private async start(load: Load): Promise<void> {
    const { handle, spec } = load;
    if (this.disposed) return;
    this.loaded.set(handle, specFingerprint(spec));
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
    try {
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
    } catch (e) {
      // `executeProvider` is total by construction — but an invoker that rejects with a value
      // whose message getter throws, a store subscriber that throws synchronously on ANY of
      // this method's publishes (including the very first "pending" one, now inside this
      // try), or any future defect must land on the widget as an error status, never as an
      // unhandled rejection that takes the host process down.
      if (this.inflight.get(handle) !== ac || ac.signal.aborted) return;
      this.inflight.delete(handle);
      try {
        // The publish below can re-trigger the very subscriber whose throw got us here (it is
        // still subscribed to this handle). A second throw here must not escape: `inflight` is
        // already cleaned up above, which is the invariant `dispose`/`recompose`/`inFlight`
        // depend on, and that must hold even if this last publish never lands (the projection
        // already committed the state that triggered the first throw, so the handle is not
        // silently stuck "ready").
        this.opts.store.setStatus(handle, {
          state: "error",
          finding: {
            code: "hydration-internal",
            severity: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        });
      } catch {
        // Ignored — see comment above.
      }
    }
  }
}
