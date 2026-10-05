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
import { MCP_INVOKE_ERRORS } from "@loom/plugin-mcp";
import { SANDBOX_ERRORS } from "@loom/plugin-sandbox";
import { type HydrationCache, specFingerprint } from "../cache";
import type { DriftReport } from "../controller";
import type { TransientInvoker } from "../invoker";
import { limitInvoker, memoInvoker } from "../invokers";
import { providerParams, relevantParams, snapshotParams } from "../params";
import { isReservedHandle } from "../projection";
import { type ExecuteOptions, executeProvider, outcomeResult } from "../provider";
import { partitionByViewer, restrictedFinding } from "../restricted";
import { type HandleLoadResult, tooDeep } from "../scheduler";
import type { HandleInventory, HandleLoadRequest, HandleRef } from "./client";
import { errorMessage, refuse, reservedFinding } from "./shared";

// The SERVER half of split hydration (see `./client` for the trust boundary): the inventory a
// client may hold, and the answers to its loads. It executes providers, so it imports the sandbox
// and the MCP plugin — never bundle it for a browser.

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
  /**
   * Who the inventory is for. A handle classified above the viewer's clearance is OMITTED — not
   * listed with a placeholder, so the client learns neither its name nor its revision. FAIL-CLOSED:
   * absent = no clearance (one `viewer-not-supplied` warn is returned if anything is classified).
   * Pass the same viewer to `serveHandles`, which refuses such a handle even if a client names it.
   */
  readonly viewer?: Viewer;
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
    const split = partitionByViewer(experienceHandles(exp), opts.viewer);
    findings.push(...split.advisory);
    for (const use of split.allowed) {
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

/**
 * The most transient calls one `serveHandles` batch has in flight by default
 * (`ServeOptions.maxConcurrentCalls`): the batch is client-sized, so the server bounds its fan-out.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 32;

export interface ServeOptions extends Omit<ExecuteOptions, "params" | "kinds"> {
  /** Kinds for `"contract"` providers: the nodes binding the handle, resolved on this surface. */
  readonly outputKinds?: { readonly catalog: SemanticCatalog; readonly surface: Surface };
  readonly cache?: HydrationCache;
  /**
   * Who the answers are for. A handle bound by any node classified above the viewer's clearance is
   * refused BEFORE its provider is looked up, cached or invoked, and the client is told exactly
   * what it is told for a handle the experience does not bind (`unknown-handle`) — no oracle for
   * which handles exist but are restricted; the full `restricted` finding goes to `onFinding`.
   * FAIL-CLOSED: absent = no clearance. Unclassified handles are unaffected.
   */
  readonly viewer?: Viewer;
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
  /**
   * At most this many transient calls in flight across the whole batch. Default
   * `DEFAULT_MAX_CONCURRENT_CALLS` (32): a client decides how many handles a batch carries, so
   * the server bounds the upstream fan-out unless it is told otherwise. It bounds ONE batch: for
   * a server-wide bound, wrap the invoker once in the exported `limitInvoker` and share that
   * wrapped invoker across every batch.
   */
  readonly maxConcurrentCalls?: number;
  /**
   * A batch longer than this is refused whole (`batch-too-large`). Default `DEFAULT_MAX_BATCH`.
   * The refusal is still one result per request, so a transport should bound request bodies.
   */
  readonly maxBatch?: number;
}

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
  "upstream-empty",
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
    case "upstream-empty":
      return "no data for this view";
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
  /** Handles bound by a node the viewer may not see: refused before anything else about them. */
  readonly restricted: ReadonlySet<string>;
  readonly kinds: ReadonlyMap<string, readonly string[]>;
}

/**
 * The server half of split hydration: answer a BATCH of handle loads for `exp` in one pass — one
 * clock read (`opts.now`, else `Date.now()` once), one step memo in front of one call cap
 * (`maxConcurrentCalls`, default 32), so identical steps across the batch's providers run once.
 * The memo is keyed by principal too, and one call serves one principal (`opts.principal`), so
 * two viewers never share a call. Every failure, a malformed request included, is a result, one per request
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
  const cap = opts.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS;
  if (!Number.isInteger(cap) || cap < 1)
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
  const { outputKinds, invoker, now, signal, principal } = opts;
  const capped: TransientInvoker = limitInvoker(
    invoker,
    opts.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS
  );
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
    restricted: new Set(
      partitionByViewer(experienceHandles(exp), opts.viewer).restricted.map((u) => u.handle)
    ),
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
    // Checked first, before the provider is even looked up: a restricted handle is never loaded,
    // cached or invoked, for any request, whatever its params.
    if (pass.restricted.has(handle)) {
      report(restrictedFinding());
      return refuse("unknown-handle", `"${handle}" is not a handle this experience binds`);
    }
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
        // Only a PROCEEDED input drift reaches here beside a delivered answer — a value, or an
        // `empty` one (the retried upstream answered with no rows). `empty` itself is never drift.
        proceeded: outcome.ok || outcome.finding.code === "upstream-empty",
      });
    return outcomeResult(outcome);
  } catch (e) {
    return refuse("hydration-internal", errorMessage(e));
  }
}
