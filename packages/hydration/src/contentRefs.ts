import {
  type ContentRefTable,
  type Finding,
  type MCPToolNode,
  type ProviderSpec,
  contentRefArgFindings,
  contentRefEntry,
  markedTopLevelKeys,
  parseContentRefTable,
  provenIn,
  stripNullContentRefs,
  toolKey,
} from "@loom-ui/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { type LoadParams, applyParamsDetailed } from "./params";

// U9b, the SERVER half: a module of its own so that the browser entry (which imports params.ts) never
// reaches `@loom-ui/core`'s root, which pulls in node:crypto.

const bad = (code: string, message: string): Finding => ({ code, severity: "error", message });

export type ContentRefPrincipal = TransientInvokeOptions["principal"];

/** What the host's gate is told about a param that would fill a content-reference argument. */
export interface ContentRefParamContext {
  readonly handle: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly kind?: string;
  readonly param: string;
  readonly value: unknown;
  /** The viewer the load runs for (the controller's `principal.id` / serve's `principalId`). */
  readonly principalId?: string;
  /** The full principal chain, when the load has one. */
  readonly principal?: ContentRefPrincipal;
}

/**
 * The host's gate on a PARAM that would fill a content-reference argument (U9b). Called once per
 * replaced top-level argument that holds a marked path (for a tool whose schema is `"unknown"`, once
 * per replaced param), EVERY time the answer is wanted: before a cache lookup as well as before a call.
 * Return `true` only for a reference the host itself vouches for: one that `acceptMediaAttach`
 * accepted, was ISSUED TO `ctx.principalId` (check issuance to THIS principal, not merely "some
 * principal"), and is still current (a revoked share must answer `false`). Synchronous; a throw or a
 * non-`true` answer refuses the step. With no gate configured, EVERY such param is refused: a param is
 * a client-reachable value and a content address is a capability.
 */
export type ContentRefParamGate = (ctx: ContentRefParamContext) => boolean;

/** Everything the guard needs about the load; built once per provider load. */
export interface ContentRefEnv {
  readonly table: ContentRefTable;
  readonly handle: string;
  readonly steps: ReadonlyMap<string, MCPToolNode>;
  readonly acceptContentRefParam?: ContentRefParamGate;
  readonly principalId?: string;
  readonly principal?: ContentRefPrincipal;
}

export const contentRefEnv = (
  table: ContentRefTable,
  spec: ProviderSpec,
  gate: ContentRefParamGate | undefined,
  who: { principalId?: string | undefined; principal?: ContentRefPrincipal | undefined }
): ContentRefEnv => ({
  table,
  handle: spec.handle,
  steps: new Map(spec.executionGraph.map((s) => [s.stepId, s] as const)),
  ...(gate !== undefined && { acceptContentRefParam: gate }),
  ...(who.principalId !== undefined && { principalId: who.principalId }),
  ...(who.principal !== undefined && { principal: who.principal }),
});

/**
 * U9b, defence in depth behind composition: after params are applied and BEFORE anything resolves,
 * a marked content-reference argument must be absent / null, a step reference to an output its tool
 * declares to be a content reference, or a param the host's gate accepted. A model-authored literal,
 * an echo / concat reference, or an ungated param refuses the step, so the call is never made.
 * `paramFilled` says a param filled a guarded argument (the caller then caches per principal only).
 */
export function checkContentRefs(
  node: MCPToolNode,
  applied: { readonly args: Record<string, unknown>; readonly replaced: readonly string[] },
  env: ContentRefEnv
): { readonly finding?: Finding; readonly paramFilled: boolean } {
  const entry = contentRefEntry(env.table, toolKey(node));
  if (entry === undefined) return { paramFilled: false };
  const skip = new Set<string>();
  // A tool whose schema mentions the marker but cannot be read: every replaced param is gated.
  const guarded =
    entry === "unknown"
      ? new Set(applied.replaced)
      : typeof entry === "string"
        ? new Set<string>()
        : markedTopLevelKeys(entry);
  let paramFilled = false;
  for (const name of applied.replaced) {
    if (!guarded.has(name)) continue;
    paramFilled = true;
    let ok = false;
    try {
      ok =
        env.acceptContentRefParam?.({
          handle: env.handle,
          stepId: node.stepId,
          toolName: node.toolName,
          ...(node.kind !== undefined && { kind: node.kind }),
          param: name,
          value: applied.args[name],
          ...(env.principalId !== undefined && { principalId: env.principalId }),
          ...(env.principal !== undefined && { principal: env.principal }),
        }) === true;
    } catch {
      ok = false;
    }
    if (!ok)
      return {
        paramFilled,
        finding: bad(
          "media-arg-literal",
          `step "${node.stepId}": the param for "${name}" fills a content-reference argument and the host did not accept it`
        ),
      };
    skip.add(name);
  }
  const found = contentRefArgFindings(applied.args, entry, `step "${node.stepId}"`, {
    skipKeys: skip,
    proven: provenIn(env.table, env.steps, node.stepId, toolKey),
  }).find((f) => f.severity === "error");
  return { paramFilled, ...(found !== undefined && { finding: found }) };
}

/** `args` without JSON null at the step's marked paths (a tool never sees `null` where a reference belongs). */
export function finishContentRefArgs(
  node: MCPToolNode,
  args: Record<string, unknown>,
  table: ContentRefTable
): Record<string, unknown> {
  const entry = contentRefEntry(table, toolKey(node));
  return entry === undefined || typeof entry === "string"
    ? args
    : stripNullContentRefs(args, entry);
}

/**
 * Judge a whole provider BEFORE a cache lookup: the same guard `executeProvider` runs per step, over
 * every step, with the gate asked now. A cached value was produced for an argument the gate accepted
 * once; serving it to another principal, or after the host revoked it, would skip the gate. A
 * refusal means: do not serve from the cache (the load itself will refuse). `paramFilled` means the
 * answer depends on who is asking: cache it per principal, never globally.
 */
export function inspectContentRefs(
  spec: ProviderSpec,
  params: LoadParams,
  env: ContentRefEnv
): { readonly refusal?: Finding; readonly paramFilled: boolean } {
  let paramFilled = false;
  for (const step of spec.executionGraph) {
    const applied = applyParamsDetailed(step, params);
    const r = checkContentRefs(step, applied, env);
    paramFilled ||= r.paramFilled;
    if (r.finding !== undefined) return { refusal: r.finding, paramFilled };
  }
  return { paramFilled };
}

const PRINCIPAL_SCOPED = new WeakMap<ProviderSpec, ProviderSpec>();

/** `spec` with `cachePolicy.scope: "principal"` (memoised per spec object, so its fingerprint is computed once). */
export function principalScoped(spec: ProviderSpec): ProviderSpec {
  if (spec.cachePolicy.scope === "principal") return spec;
  let s = PRINCIPAL_SCOPED.get(spec);
  if (s === undefined) {
    s = { ...spec, cachePolicy: { ...spec.cachePolicy, scope: "principal" } };
    PRINCIPAL_SCOPED.set(spec, s);
  }
  return s;
}

/** `contentRefArgs` is missing or malformed: a configuration error, never read as "nothing is guarded". */
export class ContentRefConfigError extends Error {
  readonly code = "content-ref-config";
  constructor(where: string) {
    super(
      `${where}: contentRefArgs is required: pass the table contentRefArgsFrom(capabilities) builds (a malformed or missing one is refused, never read as "none"), or the explicit opt-out "none"`
    );
    this.name = "ContentRefConfigError";
  }
}

/** Throws {@link ContentRefConfigError} unless `value` is `"none"` or exactly a well-formed table. */
export function assertContentRefConfig(value: unknown, where: string): void {
  if (value === "none") return;
  if (parseContentRefTable(value) === undefined) throw new ContentRefConfigError(where);
}
