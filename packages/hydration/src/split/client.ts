import type { Audience, Finding, Priority } from "@loom-ui/core";
import { checkKindValue, hasKindContract, isBroadcast } from "@loom-ui/core/browser";
import { type LoadParams, checkParams, paramsKey, pickParams } from "../params";
import {
  HydrationAudienceMismatchError,
  type HydrationStore,
  isReservedHandle,
} from "../projection";
import {
  type HandleLoadResult,
  HandleScheduler,
  KEY_SEP,
  type ScheduledJob,
  type TimerFn,
  defaultTimer,
  disposedFinding,
} from "../scheduler";
import { errorMessage, refuse, reservedFinding } from "./shared";

// ── Split hydration: providers stay on the server ─────────────────────────────
// Two sides of a trust boundary. The SERVER holds the experience with its provider specs (tool
// names, arguments, reshaping scripts). The CLIENT holds the compiled Blueprint plus a HANDLE
// INVENTORY: per bound handle, its priority (the Blueprint carries none), the NAMES of the params
// a load may override, and an opaque revision that moves when the provider behind the handle
// changes — never the provider itself, nor an unkeyed function of it: the server derives each
// revision through its own `revisionOf` (a keyed hash), so a client cannot confirm a guessed
// provider offline. `SplitHydrationController` schedules from the inventory
// exactly as the in-process controller schedules from providers (the same `HandleScheduler`) and
// loads through a `HandleLoader` — the app's transport. Loads the scheduler starts together (a
// group: the P0s of one bind, a P1 batch) go out as ONE `loadMany`.
//
// The server answers with `serveHandles` (a batch) or `serveHandle` (one): `executeProvider` plus
// the same publish mapping (`outcomeResult`), so split and in-process hydration cannot disagree.
// A batch is the server's PASS: one clock read for every relative-time token in it, one step memo
// (so N handles sharing an upstream step make one call) and one call cap. Every request is
// UNTRUSTED input: it is validated, only a handle a node actually binds is served, and a param
// never reaches an argument the provider did not declare overridable.
//
// This file is the CLIENT half: browser-safe by construction (no provider execution, no sandbox,
// no MCP runtime, no node builtin). `@loom-ui/hydration/client` exports it; the fitness test
// `clientEntry.test.ts` walks the built graph to keep it that way.

export interface HandleRef {
  readonly handle: string;
  readonly priority: Priority;
  /** Argument names a load may override (the sorted union of the provider's `overridable`). */
  readonly params: readonly string[];
  /**
   * Opaque: changes when the provider behind the handle changes. Never the provider, nor an
   * unkeyed function of it — `InventoryOptions.revisionOf` derives it on the server.
   */
  readonly revision: string;
  /** Set when the handle cannot load (no provider): published as an error, never requested. */
  readonly finding?: Finding;
}

export interface HandleInventory {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly handles: readonly HandleRef[];
}

export interface HandleLoadRequest {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly handle: string;
  /** Only the params this handle declares (the controller filters by `HandleRef.params`). */
  readonly params: LoadParams;
}

/** The app's transport. Each method answers or rejects; a rejection errors the handles it carried. */
export interface HandleLoader {
  load(request: HandleLoadRequest, signal: AbortSignal): Promise<HandleLoadResult>;
  /**
   * Several requests in ONE round trip, answered in request order — the server's `serveHandles`,
   * so they share a pass and handles sharing an upstream step share the call. Required: that
   * sharing is not optional. `signal` aborts once every request in the group has been abandoned.
   */
  loadMany(
    requests: readonly HandleLoadRequest[],
    signal: AbortSignal
  ): Promise<readonly HandleLoadResult[]>;
}

export interface SplitControllerOptions {
  readonly loader: HandleLoader;
  readonly store: HydrationStore;
  /**
   * The audience this controller draws for. When given it must agree with the store's
   * `scope.audience` both ways, or the constructor throws `HydrationAudienceMismatchError` (as
   * `HydrationController` always does). Omitted = the viewer audience: a broadcast store then throws.
   */
  readonly audience?: Audience;
  readonly setTimer?: TimerFn;
  readonly batchWindowMs?: number;
  /** Params every load starts from (e.g. `DEFAULT_TIME_RANGE`); `setParams` layers over them. */
  readonly defaultParams?: LoadParams;
}

interface RefJob extends ScheduledJob {
  readonly params: LoadParams;
  readonly experienceId: string;
  readonly versionHash: string;
}

/** One queued load in a group, waiting for the group's flush. */
interface Queued {
  readonly job: RefJob;
  readonly signal: AbortSignal;
  readonly resolve: (r: HandleLoadResult) => void;
}

/** Loads the scheduler started together: flushed as one `loadMany` a microtask later. */
interface Group {
  queue: Queued[];
}

const isFinding = (f: unknown): f is Finding =>
  f !== null &&
  typeof f === "object" &&
  typeof (f as Finding).code === "string" &&
  typeof (f as Finding).message === "string" &&
  ((f as Finding).severity === "error" || (f as Finding).severity === "warn");

const malformedResult = (handle: string): HandleLoadResult =>
  refuse(
    "load-malformed",
    `the loader answered "${handle}" with something that is not a load result`
  );

const failedResult = (handle: string, e: unknown): HandleLoadResult =>
  refuse("load-failed", `loading "${handle}" failed: ${errorMessage(e)}`);

/** A loader's answer crossed a boundary: believe only what has the shape of a load result. */
function asLoadResult(x: unknown, handle: string): HandleLoadResult {
  if (x === null || typeof x !== "object") return malformedResult(handle);
  const r = x as { state?: unknown; value?: unknown; finding?: unknown };
  const finding = isFinding(r.finding) ? r.finding : undefined;
  if (r.state === "ready")
    return finding === undefined
      ? { state: "ready", value: r.value }
      : { state: "ready", value: r.value, finding };
  // `empty` (loom ADR 0100) carries its finding and never a value: a value beside it is dropped.
  if ((r.state === "stale" || r.state === "error" || r.state === "empty") && finding !== undefined)
    return { state: r.state, finding };
  return malformedResult(handle);
}

const PRIORITIES: ReadonlySet<unknown> = new Set(["P0", "P1", "P2"]);

/** The inventory crossed a boundary too: believe only what has the shape of one. */
function isInventory(x: unknown): x is HandleInventory {
  if (x === null || typeof x !== "object") return false;
  const inv = x as { experienceId?: unknown; versionHash?: unknown; handles?: unknown };
  return (
    typeof inv.experienceId === "string" &&
    typeof inv.versionHash === "string" &&
    Array.isArray(inv.handles) &&
    inv.handles.every((r: unknown) => {
      if (r === null || typeof r !== "object") return false;
      const ref = r as Partial<Record<keyof HandleRef, unknown>>;
      return (
        typeof ref.handle === "string" &&
        PRIORITIES.has(ref.priority) &&
        typeof ref.revision === "string" &&
        Array.isArray(ref.params) &&
        ref.params.every((p: unknown) => typeof p === "string") &&
        (ref.finding === undefined || isFinding(ref.finding))
      );
    })
  );
}

/**
 * Client-side hydration across a trust boundary. Same scheduling as `HydrationController` (P0 now,
 * P1 batched, P2 on `markVisible`, once per question, supersede, dispose) over a `HandleInventory`,
 * loading through the injected `HandleLoader` — a group the scheduler starts together as ONE
 * `loadMany` — and publishing to a `HydrationStore`. A question is the handle's opaque revision
 * plus its params (defaults < global < handle-scoped, filtered to the names the inventory lists
 * for it). No cache, no clock and no drift handling here: all three are the server's.
 */
export class SplitHydrationController {
  private readonly sched: HandleScheduler<RefJob, Group, HandleLoadResult>;
  private current: HandleInventory | undefined;
  private globalParams: LoadParams = {};
  private readonly scopedParams = new Map<string, LoadParams>();

  /**
   * Throws `TypeError` for a loader missing `load` or `loadMany`, `RangeError` for
   * unrepresentable `defaultParams`.
   */
  constructor(private readonly opts: SplitControllerOptions) {
    const broadcast = isBroadcast(opts.audience);
    if (broadcast !== isBroadcast(opts.store.scope.audience))
      throw new HydrationAudienceMismatchError(broadcast);
    const loader: Partial<HandleLoader> | null | undefined = opts.loader;
    if (typeof loader?.load !== "function" || typeof loader.loadMany !== "function")
      throw new TypeError("SplitHydrationController: the loader must implement load and loadMany");
    if (opts.defaultParams !== undefined) {
      const bad = checkParams(opts.defaultParams);
      if (bad) throw new RangeError(bad.message);
    }
    this.sched = new HandleScheduler<RefJob, Group, HandleLoadResult>(
      opts.store,
      {
        newGroup: () => ({ queue: [] }),
        run: (job, signal, group) => this.enqueue(job, signal, group),
      },
      opts.setTimer ?? defaultTimer,
      opts.batchWindowMs ?? 50
    );
  }

  /**
   * Publish a value for a handle that no loader serves (a live transcript this page folds), through
   * the inventory's gate: only a handle the server LISTED is accepted (a restricted or unknown one is
   * absent from it, so it is refused), and the value must pass the contract of `kind`, which the caller
   * names (this side holds no catalogue). Refused = a finding and nothing written. NOTE: the inventory
   * does not say what KIND a listed handle feeds, so this cannot verify that `kind` is the handle's
   * widget: that is the page author's code naming its own handle, the viewer gate (listed or not) is
   * the part that is enforced here.
   */
  publishValue(
    handle: string,
    value: unknown,
    options: { readonly state?: "ready" | "pending"; readonly kind: string }
  ): { ok: true } | { ok: false; finding: Finding } {
    const listed =
      !this.sched.isDisposed &&
      !isReservedHandle(handle) &&
      this.current?.handles.some((r) => r.handle === handle && r.finding === undefined) === true;
    if (!listed)
      return {
        ok: false,
        finding: {
          code: "publish-unbound",
          severity: "error",
          message: "the handle is not in the current inventory; the value was refused",
        },
      };
    if (!hasKindContract(options.kind))
      return {
        ok: false,
        finding: {
          code: "publish-uncontracted",
          severity: "error",
          message: "the named kind has no value contract; refused",
        },
      };
    const check = checkKindValue(options.kind, value);
    if (!check.ok) return { ok: false, finding: check.finding };
    this.opts.store.setValue(handle, value, { state: options.state ?? "ready" });
    return { ok: true };
  }

  /** Bind an inventory; a second `load` IS a recompose. */
  load(inventory: HandleInventory): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("load")] };
    if (!isInventory(inventory)) return { findings: [invalidInventory()] };
    if (this.current !== undefined) return this.recompose(inventory);
    return this.bind(inventory);
  }

  /** A new inventory replaces the current one: drop unlisted handles, keep the rest, load new ones. */
  recompose(next: HandleInventory): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("recompose")] };
    // Before anything is dropped: an inventory we refuse must leave the current one as it was.
    if (!isInventory(next)) return { findings: [invalidInventory()] };
    this.sched.retain(new Set(next.handles.map((r) => r.handle)));
    return this.bind(next);
  }

  /** The surface reports a lazy (P2) widget entered the viewport. */
  markVisible(handle: string): void {
    this.sched.markVisible(handle);
  }

  /**
   * Replace the global params (no `scope.handle`) or one handle's scoped params, then re-ask
   * every bound handle whose question changed — only those, so a handle that ended on `error`
   * with an unchanged question is NOT retried here (`invalidate` retries it). `{}` clears.
   * Refused, with nothing changed, for params `checkParams` refuses or a reserved handle.
   */
  setParams(params: LoadParams, scope: { readonly handle?: string } = {}): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("setParams")] };
    const bad = checkParams(params);
    if (bad) return { findings: [bad] };
    if (scope.handle !== undefined && isReservedHandle(scope.handle))
      return { findings: [reservedFinding(scope.handle)] };
    const before =
      this.current === undefined
        ? new Map<string, string>()
        : new Map(this.jobs(this.current).jobs.map((j) => [j.handle, j.fingerprint]));
    // A copy (own enumerable keys only): a caller mutating its object later changes nothing.
    const copy: LoadParams = Object.fromEntries(Object.entries(params));
    if (scope.handle === undefined) this.globalParams = copy;
    else this.scopedParams.set(scope.handle, copy);
    if (this.current !== undefined)
      this.sched.schedule(
        this.jobs(this.current).jobs.filter((j) => before.get(j.handle) !== j.fingerprint)
      );
    return { findings: [] };
  }

  /** Ask again (one handle or all): supersedes in-flight loads; a lazy handle stays lazy. */
  invalidate(handle?: string): { findings: Finding[] } {
    if (this.sched.isDisposed) return { findings: [disposedFinding("invalidate")] };
    if (this.current === undefined) return { findings: [] };
    const { jobs } = this.jobs(this.current);
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
    this.globalParams = {};
    this.scopedParams.clear();
  }

  private bind(inventory: HandleInventory): { findings: Finding[] } {
    this.current = inventory;
    const listed = new Set(inventory.handles.map((r) => r.handle));
    for (const handle of [...this.scopedParams.keys()])
      if (!listed.has(handle)) this.scopedParams.delete(handle);
    const { jobs, findings, missing } = this.jobs(inventory);
    for (const m of missing)
      this.opts.store.setStatus(m.handle, { state: "error", finding: m.finding });
    this.sched.schedule(jobs);
    return { findings };
  }

  /** Pure: the jobs `inventory` asks for right now, and the handles that cannot load (with why). */
  private jobs(inventory: HandleInventory): {
    jobs: RefJob[];
    findings: Finding[];
    missing: Array<{ handle: string; finding: Finding }>;
  } {
    const jobs: RefJob[] = [];
    const findings: Finding[] = [];
    const missing: Array<{ handle: string; finding: Finding }> = [];
    for (const ref of inventory.handles) {
      // The inventory crossed a boundary: a reserved handle is refused here too.
      if (isReservedHandle(ref.handle)) {
        findings.push(reservedFinding(ref.handle));
        continue;
      }
      if (ref.finding !== undefined) {
        findings.push(ref.finding);
        missing.push({ handle: ref.handle, finding: ref.finding });
        continue;
      }
      const params = pickParams(
        { ...this.opts.defaultParams, ...this.globalParams, ...this.scopedParams.get(ref.handle) },
        ref.params
      );
      jobs.push({
        handle: ref.handle,
        priority: ref.priority,
        params,
        experienceId: inventory.experienceId,
        versionHash: inventory.versionHash,
        fingerprint: `${ref.revision}${KEY_SEP}${paramsKey(params)}`,
      });
    }
    return { jobs, findings, missing };
  }

  /**
   * The scheduler starts a group's jobs in one synchronous turn; each joins the group's queue and
   * the first schedules the flush, so the whole group leaves as one request.
   */
  private enqueue(job: RefJob, signal: AbortSignal, group: Group): Promise<HandleLoadResult> {
    return new Promise<HandleLoadResult>((resolve) => {
      group.queue.push({ job, signal, resolve });
      if (group.queue.length === 1) queueMicrotask(() => this.flush(group));
    });
  }

  private flush(group: Group): void {
    const queued = group.queue;
    group.queue = [];
    // Abandoned before it left (superseded, dropped, disposed): its result would be dropped anyway.
    const live: Queued[] = [];
    for (const q of queued) {
      if (q.signal.aborted)
        q.resolve(refuse("aborted", `the load of "${q.job.handle}" was abandoned`));
      else live.push(q);
    }
    if (live.length > 1) {
      this.loadGroup(live).then((results) => {
        live.forEach((q, i) => q.resolve(results[i] ?? malformedResult(q.job.handle)));
      });
      return;
    }
    for (const q of live) this.loadOne(q).then(q.resolve);
  }

  private async loadOne(q: Queued): Promise<HandleLoadResult> {
    try {
      return asLoadResult(await this.opts.loader.load(request(q.job), q.signal), q.job.handle);
    } catch (e) {
      return failedResult(q.job.handle, e);
    }
  }

  /** One `loadMany` for the group; its signal aborts once every member has been abandoned. */
  private async loadGroup(live: readonly Queued[]): Promise<HandleLoadResult[]> {
    const ac = new AbortController();
    let remaining = live.length;
    const onAbort = (): void => {
      remaining -= 1;
      if (remaining === 0) ac.abort();
    };
    for (const q of live) q.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const answer: unknown = await this.opts.loader.loadMany(
        live.map((q) => request(q.job)),
        ac.signal
      );
      if (!Array.isArray(answer) || answer.length !== live.length)
        return live.map((q) => malformedResult(q.job.handle));
      return live.map((q, i) => asLoadResult(answer[i], q.job.handle));
    } catch (e) {
      return live.map((q) => failedResult(q.job.handle, e));
    } finally {
      for (const q of live) q.signal.removeEventListener("abort", onAbort);
    }
  }
}

const invalidInventory = (): Finding => ({
  code: "invalid-inventory",
  severity: "error",
  message:
    "not a handle inventory: expected an experienceId, a versionHash and well-formed handle refs",
});

const request = (job: RefJob): HandleLoadRequest => ({
  experienceId: job.experienceId,
  versionHash: job.versionHash,
  handle: job.handle,
  params: job.params,
});
