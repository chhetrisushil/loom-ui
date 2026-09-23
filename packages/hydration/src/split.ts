import {
  type Experience,
  type Finding,
  MAX_TREE_DEPTH,
  type Priority,
  type ProviderSpec,
  type SemanticCatalog,
  type Surface,
  experienceHandles,
  handleKinds,
  treeDepth,
} from "@loom-ui/core";
import { MCP_INVOKE_ERRORS } from "@loom/plugin-mcp";
import { SANDBOX_ERRORS } from "@loom/plugin-sandbox";
import { type HydrationCache, specFingerprint } from "./cache";
import type { DriftReport } from "./controller";
import type { TransientInvoker } from "./invoker";
import { limitInvoker, memoInvoker } from "./invokers";
import {
  type LoadParams,
  checkParams,
  paramsKey,
  pickParams,
  providerParams,
  relevantParams,
  snapshotParams,
} from "./params";
import { type HydrationStore, isReservedHandle } from "./projection";
import { type ExecuteOptions, executeProvider, outcomeResult } from "./provider";
import {
  type HandleLoadResult,
  HandleScheduler,
  KEY_SEP,
  type ScheduledJob,
  type TimerFn,
  defaultTimer,
  disposedFinding,
  tooDeep,
} from "./scheduler";

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

const reservedFinding = (handle: string): Finding => ({
  code: "invalid-handle",
  severity: "error",
  message: `handle "${handle}" is reserved`,
});

/**
 * Derives a handle's public revision from the provider's content fingerprint (`specFingerprint`).
 * It must be KEYED: an unkeyed function of the fingerprint lets a client confirm a guessed provider
 * (tool, arguments) offline. In production use an HMAC over a server secret, e.g.
 * `createHmac("sha256", secret).update(handle + "\u0000" + fingerprint).digest("hex")`. It must be
 * deterministic for as long as clients hold inventories (a rotated key re-asks every handle once),
 * and it must move with the fingerprint: a per-handle constant cannot be detected here, and it
 * defeats re-asking — a client never learns that the provider behind a handle changed.
 */
export type RevisionFn = (handle: string, fingerprint: string) => string;

export interface InventoryOptions {
  readonly revisionOf: RevisionFn;
}

/**
 * What a client may know about an experience's data plane: never a provider. Throws `TypeError`
 * without a `revisionOf`, or when it returns a non-string, an empty string or the fingerprint.
 */
export function handleInventory(
  exp: Experience,
  opts: InventoryOptions
): {
  inventory: HandleInventory;
  findings: Finding[];
} {
  const revisionOf = opts?.revisionOf;
  if (typeof revisionOf !== "function")
    throw new TypeError("handleInventory: a revisionOf (a keyed hash) is required");
  const findings: Finding[] = [];
  const handles: HandleRef[] = [];
  if (treeDepth(exp.root) > MAX_TREE_DEPTH) {
    findings.push(tooDeep(exp.experienceId, MAX_TREE_DEPTH));
  } else {
    for (const use of experienceHandles(exp)) {
      if (isReservedHandle(use.handle)) {
        findings.push(reservedFinding(use.handle));
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
        handles.push({
          handle: use.handle,
          priority: use.priority,
          params: [],
          revision: "",
          finding: f,
        });
        continue;
      }
      handles.push({
        handle: use.handle,
        priority: use.priority,
        params: providerParams(spec),
        revision: publicRevision(revisionOf, use.handle, spec),
      });
    }
  }
  return {
    inventory: { experienceId: exp.experienceId, versionHash: exp.versionHash, handles },
    findings,
  };
}

function publicRevision(revisionOf: RevisionFn, handle: string, spec: ProviderSpec): string {
  const fingerprint = specFingerprint(spec);
  const revision = revisionOf(handle, fingerprint);
  if (typeof revision !== "string" || revision === "")
    throw new TypeError(
      `handleInventory: revisionOf returned ${revision === "" ? "an empty string" : `a ${typeof revision}`} for "${handle}"`
    );
  if (revision.includes(fingerprint))
    throw new TypeError(
      `handleInventory: revisionOf returned the provider fingerprint for "${handle}"; it must be keyed`
    );
  return revision;
}

/** The most requests one `serveHandles` call serves by default (`ServeOptions.maxBatch`). */
export const DEFAULT_MAX_BATCH = 256;

export interface ServeOptions extends Omit<ExecuteOptions, "params" | "kinds"> {
  /** Kinds for `"contract"` providers: the nodes binding the handle, resolved on this surface. */
  readonly outputKinds?: { readonly catalog: SemanticCatalog; readonly surface: Surface };
  readonly cache?: HydrationCache;
  /** Keys a `principal`-scoped cache entry; without it such a provider is never cached. */
  readonly principalId?: string;
  readonly onDrift?: (report: DriftReport) => void;
  /**
   * Every finding a load produced, IN FULL (tool, step, script, hashes, exception text), for the
   * server's own logs. What the client receives is only its public form (`publicFinding`). A
   * throw here, or a rejection of the promise it returns, is swallowed: a logging hook never
   * changes what a client is answered.
   */
  readonly onFinding?: (handle: string, finding: Finding) => unknown;
  /** At most this many transient calls in flight across the whole batch. Default: unbounded. */
  readonly maxConcurrentCalls?: number;
  /** A batch longer than this is refused whole (`batch-too-large`). Default `DEFAULT_MAX_BATCH`. */
  readonly maxBatch?: number;
}

const refuse = (code: string, message: string): HandleLoadResult => ({
  state: "error",
  finding: { code, severity: "error", message },
});

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The failure channels loom itself declares (ADR 0060) — `mcp.invoke`'s and the sandbox's, derived
 * from loom's own exports so the list cannot drift. A `tool-<channel>` / `reshape-<channel>` code
 * is built from whatever channel the (pluggable) invoker threw, which is arbitrary text; only
 * these are served as they are.
 */
const TOOL_CHANNELS: ReadonlySet<string> = new Set(Object.keys(MCP_INVOKE_ERRORS));
const RESHAPE_CHANNELS: ReadonlySet<string> = new Set(Object.keys(SANDBOX_ERRORS));

/**
 * Every other code a served finding may carry: the fixed codes hydration and the server mint
 * themselves. Anything else is replaced (`load-failed` / `load-warning`) — the code is a fixed
 * vocabulary, never text a provider or an invoker chose.
 */
const FIXED_CODES: ReadonlySet<string> = new Set([
  "tool-failed",
  "reshape-failed",
  "reshape-unregistered",
  "schema-drift",
  "schema-drift-proceeded",
  "output-shape-drift",
  "output-shape-unhashable",
  "output-shape-unpinned",
  "output-contract-drift",
  "output-contract-unchecked",
  "output-contract-unbound",
  "param-not-overridable",
  "param-templated",
  "param-template-refused",
  "invalid-params",
  "invalid-time-token",
  "argument-hook-failed",
  "unresolved-step-reference",
  "dependency-failed",
  "provider-failed",
  "empty-graph",
  "graph-cycle",
  "aborted",
  "invalid-request",
  "version-mismatch",
  "invalid-handle",
  "unknown-handle",
  "batch-too-large",
  "tree-too-deep",
  "hydration-internal",
]);

function publicCode(finding: Finding): string {
  const { code } = finding;
  if (FIXED_CODES.has(code)) return code;
  if (code.startsWith("tool-")) return TOOL_CHANNELS.has(code.slice(5)) ? code : "tool-failed";
  if (code.startsWith("reshape-"))
    return RESHAPE_CHANNELS.has(code.slice(8)) ? code : "reshape-failed";
  return finding.severity === "warn" ? "load-warning" : "load-failed";
}

/**
 * What a client may be told about a finding: a fixed text keyed by its PUBLIC code. The fixed
 * codes' own cases run FIRST, so one of them that happens to share a `tool-`/`reshape-` prefix
 * with an allow-listed channel code (`reshape-unregistered`, a hydration-minted code, not a
 * channel) gets its own text instead of the generic prefix fallback below.
 */
function publicText(code: string, severity: Finding["severity"]): string {
  switch (code) {
    case "schema-drift-proceeded":
      return "input schema changed; served with the observed schema";
    case "schema-drift":
      return "input schema changed; waiting for a repair";
    case "output-shape-drift":
    case "output-shape-unhashable":
    case "output-contract-drift":
      return "the output no longer matches what it declares; waiting for a repair";
    case "output-shape-unpinned":
    case "output-contract-unchecked":
      return "the output is served unchecked";
    case "output-contract-unbound":
      return "the output cannot be checked";
    case "reshape-unregistered":
      return "the output could not be reshaped: the named reshaper is not registered";
    case "param-not-overridable":
      return "a param was ignored";
    case "invalid-params":
    case "invalid-time-token":
      return "the params were refused";
    case "aborted":
      return "the load was aborted";
    case "invalid-request":
      return "the request is malformed";
    case "version-mismatch":
      return "the request is for another version of the experience";
    case "invalid-handle":
      return "the handle is reserved";
    case "unknown-handle":
      return "not a handle this experience binds";
    case "batch-too-large":
      return "the batch is too large";
    case "tree-too-deep":
      return "the experience cannot be served";
    case "hydration-internal":
      return "an internal error occurred";
  }
  if (code.startsWith("tool-")) return "a tool call failed";
  if (code.startsWith("reshape-")) return "the output could not be reshaped";
  return severity === "warn" ? "loaded with a warning" : "could not be loaded";
}

/**
 * The public form of a finding: `severity` kept; the code kept when it is one of the fixed codes
 * or a loom-declared channel (otherwise the generic `tool-failed` / `reshape-failed` /
 * `load-failed` / `load-warning`); the message a template keyed by that code, naming only the
 * (client-supplied) handle — never a node, step, tool, script, hash, argument, channel or
 * exception text.
 */
export function publicFinding(handle: string | undefined, finding: Finding): Finding {
  const code = publicCode(finding);
  const text = publicText(code, finding.severity);
  return {
    code,
    severity: finding.severity,
    message:
      handle === undefined ? text : `handle ${JSON.stringify(handle.slice(0, 128))}: ${text}`,
  };
}

type Report = (finding: Finding) => void;

/** Hands each finding to `onFinding` once, in full; a throwing hook is swallowed. */
function reporter(opts: ServeOptions, handle: string): Report {
  const seen = new Set<Finding>();
  return (finding) => {
    if (seen.has(finding)) return;
    seen.add(finding);
    try {
      const ret: unknown = opts.onFinding?.(handle, finding);
      // An async hook's rejection is its own: never an unhandled rejection in the server.
      if (
        ret !== null &&
        typeof ret === "object" &&
        typeof (ret as PromiseLike<unknown>).then === "function"
      )
        Promise.resolve(ret).catch(() => {});
    } catch {
      // A logging hook must never change what the client is answered (nor, if its `then`
      // getter throws, what the server does).
    }
  };
}

/** Report the result's finding in full, and answer the client with its public form. */
function publicResult(
  handle: string | undefined,
  result: HandleLoadResult,
  report: Report
): HandleLoadResult {
  if (result.finding === undefined) return result;
  report(result.finding);
  const finding = publicFinding(handle, result.finding);
  return result.state === "ready"
    ? { state: "ready", value: result.value, finding }
    : { state: result.state, finding };
}

/** What one batch shares: computed once, whatever the batch asks. */
interface ServePass {
  readonly exec: ExecuteOptions;
  readonly bound: ReadonlySet<string>;
  readonly kinds: ReadonlyMap<string, readonly string[]>;
}

/**
 * The server half of split hydration: answer a BATCH of handle loads for `exp` in one pass — one
 * clock read (`opts.now`, else `Date.now()` once), one step memo in front of one call cap
 * (`maxConcurrentCalls`), so identical steps across the batch's providers run once. The memo is
 * keyed by principal too, and one call serves one principal (`opts.principal`), so two viewers
 * never share a call. Every failure, a malformed request included, is a result, one per request
 * in request order (a batch that is not a list gets one `invalid-request`) — and every finding a
 * client receives is its PUBLIC form (`publicFinding`); the full one goes to `onFinding`. Rejects
 * with `TypeError` only for a server misconfiguration (`maxBatch`, `maxConcurrentCalls`).
 */
export async function serveHandles(
  exp: Experience,
  requests: readonly HandleLoadRequest[],
  opts: ServeOptions
): Promise<HandleLoadResult[]> {
  // Server configuration, not client input: a bad bound is a programming error, and loud.
  const max = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  if (!Number.isInteger(max) || max < 1)
    throw new TypeError(`serveHandles: maxBatch must be a positive integer, got ${String(max)}`);
  const cap = opts.maxConcurrentCalls;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1))
    throw new TypeError(
      `serveHandles: maxConcurrentCalls must be a positive integer, got ${String(cap)}`
    );
  const batch = reporter(opts, "");
  if (!Array.isArray(requests))
    return [
      publicResult(
        undefined,
        refuse("invalid-request", "a batch load is a list of load requests"),
        batch
      ),
    ];
  if (requests.length > max) {
    const tooMany = publicResult(
      undefined,
      refuse(
        "batch-too-large",
        `a batch of ${requests.length} requests exceeds the bound of ${max}`
      ),
      batch
    );
    return requests.map(() => tooMany);
  }
  // Checked before anything walks the tree for handles or kinds.
  if (treeDepth(exp.root) > MAX_TREE_DEPTH) {
    const deep = publicResult(
      undefined,
      { state: "error", finding: tooDeep(exp.experienceId, MAX_TREE_DEPTH) },
      batch
    );
    return requests.map(() => deep);
  }
  let pass: ServePass;
  try {
    pass = openPass(exp, opts);
  } catch (e) {
    const failed = publicResult(undefined, refuse("hydration-internal", errorMessage(e)), batch);
    return requests.map(() => failed);
  }
  return Promise.all(
    requests.map(async (r) => {
      // Snapshotted ONCE, inside a guard: a hostile getter or Proxy costs this request, not the
      // batch. `experienceId`/`versionHash`/`handle` are primitives, captured by value right here.
      // `params`, an object, is NOT safe by the same copy — a field holding a live reference can
      // still answer a later read differently — so `serveOne` takes its own single deep-copy-and-
      // validate pass over it (`snapshotParams`) before anything reads a key of it twice.
      let snapshot: HandleLoadRequest | null;
      try {
        snapshot =
          r !== null && typeof r === "object"
            ? {
                experienceId: r.experienceId,
                versionHash: r.versionHash,
                handle: r.handle,
                params: r.params,
              }
            : null;
      } catch {
        const report = reporter(opts, "");
        return publicResult(
          undefined,
          refuse("invalid-request", "the request cannot be read"),
          report
        );
      }
      const handle = typeof snapshot?.handle === "string" ? snapshot.handle : undefined;
      const report = reporter(opts, handle ?? "");
      return publicResult(handle, await serveOne(exp, snapshot, opts, pass, report), report);
    })
  );
}

/**
 * Answer ONE handle load for `exp` — a batch of one (`serveHandles`). `opts.now` should be the
 * server's clock: relative time is resolved here, never on the client.
 */
export async function serveHandle(
  exp: Experience,
  request: HandleLoadRequest,
  opts: ServeOptions
): Promise<HandleLoadResult> {
  const [result] = await serveHandles(exp, [request], opts);
  return result ?? refuse("hydration-internal", "no result for the request");
}

function openPass(exp: Experience, opts: ServeOptions): ServePass {
  const { outputKinds, maxConcurrentCalls, invoker, now, signal, principal } = opts;
  const capped: TransientInvoker =
    maxConcurrentCalls === undefined ? invoker : limitInvoker(invoker, maxConcurrentCalls);
  const exec: ExecuteOptions = {
    // One memo per batch, in front of the cap: a memo hit never takes a slot.
    invoker: memoInvoker(capped),
    now: now ?? Date.now(),
    ...(signal !== undefined && { signal }),
    ...(principal !== undefined && { principal }),
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    ...(opts.captureSample !== undefined && { captureSample: opts.captureSample }),
    ...(opts.argumentHook !== undefined && { argumentHook: opts.argumentHook }),
    ...(opts.inputDrift !== undefined && { inputDrift: opts.inputDrift }),
    ...(opts.reshapers !== undefined && { reshapers: opts.reshapers }),
  };
  return {
    exec,
    bound: new Set(experienceHandles(exp).map((u) => u.handle)),
    kinds:
      outputKinds === undefined
        ? new Map()
        : handleKinds(exp, outputKinds.catalog, outputKinds.surface),
  };
}

async function serveOne(
  exp: Experience,
  request: HandleLoadRequest | null,
  opts: ServeOptions,
  pass: ServePass,
  report: Report
): Promise<HandleLoadResult> {
  try {
    if (request === null || typeof request !== "object" || typeof request.handle !== "string")
      return refuse("invalid-request", "a load request names a handle");
    if (request.experienceId !== exp.experienceId || request.versionHash !== exp.versionHash)
      return refuse(
        "version-mismatch",
        `the request is for ${String(request.experienceId)}@${String(request.versionHash)}, not ${exp.experienceId}@${exp.versionHash}`
      );
    const handle = request.handle;
    if (isReservedHandle(handle)) return { state: "error", finding: reservedFinding(handle) };
    // Only what a node binds is served: a provider no node binds is not the client's to ask for.
    const spec =
      pass.bound.has(handle) && Object.hasOwn(exp.providers, handle)
        ? exp.providers[handle]
        : undefined;
    if (spec === undefined)
      return refuse("unknown-handle", `"${handle}" is not a handle this experience binds`);
    // ONE deep-copy-and-validate pass over the request's params (`snapshotParams`): the result is
    // plain, detached data with no accessor of its own, so `relevantParams`/`pickParams` below can
    // never re-trigger a caller-supplied getter that answered differently than the check just did.
    const snap = snapshotParams(request.params ?? {});
    if (!snap.ok) return { state: "error", finding: snap.finding };
    const params = relevantParams(spec, snap.params);
    // As in-process: only a contract provider's value is answerable to a kind.
    const kinds = spec.outputCheck === "contract" ? (pass.kinds.get(handle) ?? []) : undefined;
    const variant = kinds === undefined ? { params } : { params, kinds };
    const hit = opts.cache?.get(spec, opts.principalId, variant);
    if (hit) return { state: "ready", value: hit.value };
    const outcome = await executeProvider(spec, {
      ...pass.exec,
      params,
      ...(kinds !== undefined && { kinds }),
    });
    for (const f of outcome.findings) report(f);
    if (!outcome.ok) report(outcome.finding);
    const drift = outcome.drift ?? [];
    // Never cache a result that proceeded past an input drift (`report-and-proceed`): the key
    // does not carry the drift mode, so a later request served under the default (`report`)
    // would get it as a clean `ready` — no stale, no `onDrift`, no `onFinding`.
    if (outcome.ok && drift.length === 0)
      opts.cache?.set(spec, opts.principalId, outcome.value, variant);
    if (drift.length > 0)
      opts.onDrift?.({
        experienceId: exp.experienceId,
        versionHash: exp.versionHash,
        handle,
        spec,
        drift,
        findings: outcome.findings,
        proceeded: outcome.ok,
      });
    return outcomeResult(outcome);
  } catch (e) {
    return refuse("hydration-internal", errorMessage(e));
  }
}

export interface SplitControllerOptions {
  readonly loader: HandleLoader;
  readonly store: HydrationStore;
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
  if ((r.state === "stale" || r.state === "error") && finding !== undefined)
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
