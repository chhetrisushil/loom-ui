import type { Finding, Priority } from "@loom-ui/core";
import type { HydrationStore } from "./projection";

// ── Handle scheduling, independent of WHERE a handle is loaded ────────────────
// What both controllers share: each handle loaded once per QUESTION (a job's fingerprint), at its
// priority — P0 now, P1 collected in a batching window, P2 held until the surface says the widget
// is visible — superseded loads aborted and their late results dropped, and nothing ever leaking
// a rejection (`start` publishes its own failures as an `error` status). HOW a job loads is the
// owner's `run`: in-process through `executeProvider`, or across a trust boundary through a
// `HandleLoader`. Jobs started together share one GROUP (the in-process controller's pass, which
// fixes the clock and memoizes identical steps across the handles in it). Clock and timers are
// injected: scheduling is a pure function of the calls made.
//
// A re-queued P2 (its question changed, or it was invalidated) goes back to waiting for the
// surface's NEXT `markVisible`: invalidating must not fetch data for something off-screen, so a
// surface re-reports visibility for widgets it still shows.

export interface ScheduledJob {
  readonly handle: string;
  readonly priority: Priority;
  /** The identity of the question. Same fingerprint + a live status = already asked; no re-run. */
  readonly fingerprint: string;
}

/** What a load publishes. Serializable: it is also what a `HandleLoader` returns across a boundary. */
export type HandleLoadResult =
  | { readonly state: "ready"; readonly value: unknown; readonly finding?: Finding }
  | { readonly state: "stale" | "error"; readonly finding: Finding };

export interface SchedulerHooks<J extends ScheduledJob, G, R extends HandleLoadResult> {
  newGroup(): G;
  run(job: J, signal: AbortSignal, group: G): Promise<R>;
  /** A value that needs no load (a cache hit): published `ready` at once. */
  cached?(job: J): { readonly value: unknown } | undefined;
  /** The result is current (not superseded, not aborted) and about to be published. */
  commit?(job: J, result: R): void;
  /**
   * The result was published. A throw here is swallowed: the handle keeps the status just
   * published (the load is no longer in flight, so it is not moved to an error status) and
   * nothing rejects.
   */
  published?(job: J, result: R): void;
}

export type TimerFn = (fn: () => void, ms: number) => () => void;

export const defaultTimer: TimerFn = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** NUL: cannot occur in a handle or a hash, so joined fingerprints never collide. */
export const KEY_SEP = String.fromCharCode(0);

export const disposedFinding = (what: string): Finding => ({
  code: "disposed",
  severity: "error",
  message: `the hydration controller is disposed; ${what} does nothing`,
});

export const tooDeep = (experienceId: string, max: number): Finding => ({
  code: "tree-too-deep",
  severity: "error",
  message: `experience "${experienceId}" exceeds MAX_TREE_DEPTH (${max})`,
});

export class HandleScheduler<J extends ScheduledJob, G, R extends HandleLoadResult> {
  private readonly inflight = new Map<string, AbortController>();
  /**
   * P1 jobs waiting for the batch timer, ONE per handle: a question changed inside the window
   * replaces the queued one (the old one would otherwise start first and wedge the new one).
   */
  private pending = new Map<string, J>();
  private cancelBatch: (() => void) | undefined;
  private readonly lazy = new Map<string, J>();
  /** handle → fingerprint of the job it was last STARTED with. Pruned with the handle. */
  private readonly loaded = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly store: HydrationStore,
    private readonly hooks: SchedulerHooks<J, G, R>,
    private readonly setTimer: TimerFn = defaultTimer,
    private readonly batchWindowMs = 50
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Schedule by priority; a job whose question is already answered (or being answered) is skipped. */
  schedule(jobs: readonly J[]): void {
    if (this.disposed) return;
    // One group for every job this call starts now (a P1 batch and a markVisible get their own).
    const now = this.lazyGroup();
    for (const job of jobs) this.scheduleOne(job, now);
  }

  /** Keep only these handles: abort, dequeue, forget and unpublish every other one. */
  retain(keep: ReadonlySet<string>): void {
    const drop = new Set<string>();
    for (const handle of [
      ...this.inflight.keys(),
      ...this.lazy.keys(),
      ...this.pending.keys(),
      ...this.store.handles(),
    ])
      if (!keep.has(handle)) drop.add(handle);
    if (drop.size === 0) return;
    for (const handle of drop) {
      this.inflight.get(handle)?.abort();
      this.inflight.delete(handle);
      this.lazy.delete(handle);
      this.pending.delete(handle);
      this.loaded.delete(handle);
      if (this.store.status(handle) !== undefined) this.store.remove(handle);
    }
  }

  /**
   * Ask again even if already asked: each in-flight load is superseded and a fresh one starts at
   * once (one group). A lazy job stays lazy — its status untouched, its last value on screen.
   */
  reload(jobs: readonly J[]): void {
    if (this.disposed) return;
    const group = this.lazyGroup();
    for (const job of jobs) {
      this.inflight.get(job.handle)?.abort();
      this.inflight.delete(job.handle);
      this.pending.delete(job.handle); // started below (or re-queued lazy): not a second time
      if (job.priority === "P2") {
        this.lazy.set(job.handle, job);
        continue;
      }
      this.start(job, group()).catch(() => {});
    }
  }

  /** The surface reports a lazy (P2) widget entered the viewport. */
  markVisible(handle: string): void {
    if (this.disposed) return;
    const job = this.lazy.get(handle);
    if (!job) return;
    this.lazy.delete(handle);
    this.start(job, this.hooks.newGroup()).catch(() => {});
  }

  inFlight(): string[] {
    return [...this.inflight.keys()].sort();
  }

  /** Terminal: every in-flight or queued load ends on an error status, and nothing schedules again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [handle, ac] of this.inflight) {
      ac.abort();
      // The widget must not sit on a spinner forever because its controller went away.
      this.store.setStatus(handle, {
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
    for (const job of this.pending.values()) {
      // Already published `pending`; leaving it there would spin the widget forever waiting on a
      // batch timer that just got cancelled. Lazy jobs were never published: nothing to terminate.
      this.store.setStatus(job.handle, {
        state: "error",
        finding: {
          code: "disposed",
          severity: "error",
          message: `hydration for "${job.handle}" was disposed while queued`,
        },
      });
    }
    this.pending.clear();
    this.lazy.clear();
    this.loaded.clear();
  }

  /** A group made on first use, then shared: a call that starts nothing makes none. */
  private lazyGroup(): () => G {
    let made: { readonly group: G } | undefined;
    return () => {
      if (made === undefined) made = { group: this.hooks.newGroup() };
      return made.group;
    };
  }

  private scheduleOne(job: J, group: () => G): void {
    const st = this.store.status(job.handle)?.state;
    if (this.loaded.get(job.handle) === job.fingerprint) {
      // Same question, already asked: loading, loaded, or drifted-and-awaiting-repair.
      if (st === "ready" || st === "pending" || st === "stale") return;
    } else {
      // A different question for this handle: whatever is in flight answers the OLD one.
      this.inflight.get(job.handle)?.abort();
      this.inflight.delete(job.handle);
    }
    // A job queued for the batch answers the old question (or the old priority): this one owns it.
    this.pending.delete(job.handle);
    if (job.priority === "P2") {
      this.lazy.set(job.handle, job);
      return;
    }
    this.lazy.delete(job.handle); // promoted out of P2: the lazy entry has a new owner
    if (job.priority === "P0") {
      this.start(job, group()).catch(() => {});
      return;
    }
    this.store.setStatus(job.handle, { state: "pending" });
    // Keyed by handle: a changed question REPLACES the queued one rather than queueing behind it.
    this.pending.set(job.handle, job);
    this.cancelBatch ??= this.setTimer(() => {
      this.cancelBatch = undefined;
      const batch = [...this.pending.values()];
      this.pending.clear();
      if (batch.length === 0) return;
      const g = this.hooks.newGroup();
      for (const j of batch) this.start(j, g).catch(() => {});
    }, this.batchWindowMs);
  }

  private async start(job: J, group: G): Promise<void> {
    const { handle } = job;
    if (this.disposed) return;
    this.loaded.set(handle, job.fingerprint);
    const cached = this.hooks.cached?.(job);
    if (cached) {
      this.inflight.delete(handle);
      this.store.setValue(handle, cached.value, { state: "ready" });
      return;
    }
    if (this.inflight.has(handle)) return;
    const ac = new AbortController();
    this.inflight.set(handle, ac);
    try {
      this.store.setStatus(handle, { state: "pending" });
      const result = await this.hooks.run(job, ac.signal, group);
      if (this.inflight.get(handle) !== ac || ac.signal.aborted) return; // superseded or aborted
      this.inflight.delete(handle);
      this.hooks.commit?.(job, result);
      if (result.state === "ready")
        this.store.setValue(handle, result.value, {
          state: "ready",
          ...(result.finding && { finding: result.finding }),
        });
      else this.store.setStatus(handle, { state: result.state, finding: result.finding });
      this.hooks.published?.(job, result);
    } catch (e) {
      // `run` is total by construction — but a loader or invoker that rejects with a value whose
      // message getter throws, a store subscriber that throws synchronously on ANY publish here
      // (including the first `pending`), or any future defect must land on the widget as an error
      // status, never as an unhandled rejection that takes the host process down.
      if (this.inflight.get(handle) !== ac || ac.signal.aborted) return;
      this.inflight.delete(handle);
      try {
        // The publish below can re-trigger the very subscriber whose throw got us here. A second
        // throw must not escape: `inflight` is already cleaned up, which is the invariant
        // `dispose`/`retain`/`inFlight` depend on.
        this.store.setStatus(handle, {
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
