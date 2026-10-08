import {
  type ArgPath,
  type Finding,
  type MCPToolNode,
  contentRefArgFindings,
  markedTopLevelKeys,
} from "@loom-ui/core";

// U9b, the SERVER half: a module of its own so that the browser entry (which imports params.ts) never
// reaches `@loom-ui/core`'s root, which pulls in node:crypto.

const bad = (code: string, message: string): Finding => ({ code, severity: "error", message });

/**
 * The host's gate on a PARAM that would fill a content-reference argument (U9b). Called once per
 * replaced top-level argument that holds a marked path, with the value the param carries; `true`
 * only for a reference the host itself vouches for (one that came out of `acceptMediaAttach` for
 * THIS principal and is still the stored truth). Synchronous; a throw or a non-`true` answer refuses
 * the step. With no gate configured, EVERY such param is refused: a param is a client-reachable
 * value and a content address is a capability.
 */
export type ContentRefParamGate = (ctx: {
  readonly handle: string;
  readonly stepId: string;
  readonly toolName: string;
  readonly kind?: string;
  readonly param: string;
  readonly value: unknown;
}) => boolean;

/**
 * U9b, defence in depth behind composition: after params are applied and BEFORE anything resolves,
 * a marked content-reference argument must be a step reference, absent, or a param the host's gate
 * accepted. A model-authored literal (it survived because validation was skipped, or the experience
 * was written by something else) refuses the step, so the call is never made.
 */
export function checkContentRefs(
  node: MCPToolNode,
  applied: { readonly args: Record<string, unknown>; readonly replaced: readonly string[] },
  ctx: {
    readonly handle: string;
    readonly contentRefs: readonly ArgPath[] | "unknown" | undefined;
    readonly acceptContentRefParam?: ContentRefParamGate;
  }
): Finding | undefined {
  const marked = ctx.contentRefs;
  if (marked === undefined) return undefined;
  const skip = new Set<string>();
  if (marked !== "unknown") {
    const top = markedTopLevelKeys(marked);
    for (const name of applied.replaced) {
      if (!top.has(name)) continue;
      let ok = false;
      try {
        ok =
          ctx.acceptContentRefParam?.({
            handle: ctx.handle,
            stepId: node.stepId,
            toolName: node.toolName,
            ...(node.kind !== undefined && { kind: node.kind }),
            param: name,
            value: applied.args[name],
          }) === true;
      } catch {
        ok = false;
      }
      if (!ok)
        return bad(
          "media-arg-literal",
          `step "${node.stepId}": the param for "${name}" fills a content-reference argument and the host did not accept it`
        );
      skip.add(name);
    }
  }
  const found = contentRefArgFindings(applied.args, marked, `step "${node.stepId}"`, {
    skipKeys: skip,
  }).find((f) => f.severity === "error");
  return found;
}
