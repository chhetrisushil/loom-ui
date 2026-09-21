import type { Finding, ProviderSpec } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { SANDBOX_TOOL_ID, shapeHash } from "@loom/plugin-sandbox";
import type { TransientInvoker } from "./invoker";
import { resolvePath } from "./plan";

// ── Reshaping ─────────────────────────────────────────────────────────────────
// `QuickJS`: a content-addressed script runs in loom's sandbox (the effect-local middleware,
// limits and typed channels apply; nothing is logged). `JSONPath`: the scriptRef IS the path,
// selected inline — see the ProviderSpec.reshaping comment in core for the convention.

export type ReshapeResult = { ok: true; value: unknown } | { ok: false; finding: Finding };

/**
 * A finding MESSAGE must never be the thing that throws. A `TypedFailure` payload is authored by
 * a tool server or a sandbox script — it can be cyclic, or carry a bigint, and `JSON.stringify`
 * throws on both. Losing the payload text is a far better outcome than losing the finding.
 * (Not exported from the package index: it exists for this package's message building.)
 */
export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "[unserializable payload]";
  }
}

export function jsonPathSelect(value: unknown, path: string): ReshapeResult {
  if (path === "" || path === "$") return { ok: true, value };
  const out = resolvePath(value, path);
  if (out === undefined)
    return {
      ok: false,
      finding: {
        code: "reshape-failed",
        severity: "error",
        message: `JSONPath "${path}" selects nothing from the tool output`,
      },
    };
  return { ok: true, value: out };
}

export async function reshape(
  reshaping: ProviderSpec["reshaping"],
  raw: unknown,
  ctx: {
    invoker: TransientInvoker;
    signal?: AbortSignal;
    principal?: TransientInvokeOptions["principal"];
  }
): Promise<ReshapeResult> {
  if (reshaping.engine === "JSONPath") return jsonPathSelect(raw, reshaping.scriptRef);
  try {
    const value = await ctx.invoker.invokeTransient(
      SANDBOX_TOOL_ID,
      { scriptRef: { __loomContent: reshaping.scriptRef }, input: raw },
      {
        label: "loom-ui.reshape",
        ...(ctx.signal && { signal: ctx.signal }),
        ...(ctx.principal && { principal: ctx.principal }),
      }
    );
    return { ok: true, value };
  } catch (err) {
    if (err instanceof TypedFailure)
      return {
        ok: false,
        finding: {
          code: `reshape-${err.channel}`,
          severity: "error",
          message: `sandbox ${err.channel}: ${safeStringify(err.payload)}`,
        },
      };
    return {
      ok: false,
      finding: {
        code: "reshape-failed",
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** The output-shape fingerprint. The planner pins `ProviderSpec.outputShapeHash` with THIS function. */
export function outputShapeHashOf(value: unknown): string {
  return shapeHash(value);
}
