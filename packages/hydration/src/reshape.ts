import type { Finding, ProviderSpec } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { type SANDBOX_ERRORS, SANDBOX_TOOL_ID, shapeHash } from "@loom/plugin-sandbox";
import type { TransientInvoker } from "./invoker";
import { resolvePath } from "./plan";

// ── Reshaping ─────────────────────────────────────────────────────────────────
// `QuickJS`: a content-addressed script runs in loom's sandbox (the effect-local middleware,
// limits and typed channels apply; nothing is logged). `JSONPath`: the scriptRef IS the path,
// selected inline — see the ProviderSpec.reshaping comment in core for the convention. `Named`:
// the scriptRef names a reshaper the HOST registered (`defineReshapers`); it runs in-process as
// host code, trusted like the host, with no sandbox hop. Each engine has its own branch: an
// engine this function does not know is never sent to the sandbox by default.

/**
 * Why a reshaping failed, when the tool OUTPUT demonstrably caused it — the failures a re-authored
 * binding can repair. Typed from the failure's channel and payload, never from message text:
 * `script-error` (the sandbox reports the script threw on this input: a `TypedFailure` on loom's
 * `scriptError` channel, `SANDBOX_ERRORS.scriptError`), `selects-nothing` (a JSONPath selects nothing), `named-threw`
 * (a Named reshaper threw), and the deterministic resource limits a script hit on this input
 * (`limit-cpu`, `limit-memory`, `limit-output`). Anything else — a `wallClock` limit (host-load
 * dependent), a missing script, an unregistered reshaper, an untyped throw (transport, worker
 * pool, integrity), an authorization or quota denial, an abort — has no kind: it is not drift.
 */
export type ReshapeFailureKind =
  | "script-error"
  | "selects-nothing"
  | "named-threw"
  | "limit-cpu"
  | "limit-memory"
  | "limit-output";

/** A channel loom's sandbox declares (`SANDBOX_ERRORS`) — a rename there fails to compile here. */
type SandboxChannel = keyof typeof SANDBOX_ERRORS;

/**
 * The channel loom's sandbox completes on when the SCRIPT itself threw on its input (its own
 * exception, a SyntaxError, a ReferenceError for a global the VM lacks). Recognised by channel
 * only: its payload (`{ name?, message }`) is script-authored, UNTRUSTED text and is never read.
 */
const SCRIPT_ERROR: SandboxChannel = "scriptError";
const LIMIT_EXCEEDED: SandboxChannel = "limitExceeded";

export type ReshapeResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      finding: Finding;
      /** Set only when the output demonstrably caused the failure (see `ReshapeFailureKind`). */
      failureKind?: ReshapeFailureKind;
    };

/** A sandbox `TypedFailure` → the output-caused kind it proves, if any. Channel + payload only. */
function sandboxFailureKind(e: TypedFailure): ReshapeFailureKind | undefined {
  if (e.channel === SCRIPT_ERROR) return "script-error";
  if (e.channel !== LIMIT_EXCEEDED) return undefined;
  const kind = (e.payload as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "cpu") return "limit-cpu";
  if (kind === "memory") return "limit-memory";
  if (kind === "output") return "limit-output";
  return undefined; // wallClock (host-load dependent) or an unknown kind
}

/** A host-registered reshaper: the raw terminal output in, the widget's value out. */
export type Reshaper = (input: unknown) => unknown | Promise<unknown>;

/** Where `Named` reshaping looks a name up. Injected — hydration registers nothing itself. */
export interface ReshaperRegistry {
  get(name: string): Reshaper | undefined;
}

/**
 * A registry over a plain record. Map-backed, so only the record's OWN entries are registered —
 * `"constructor"` or `"__proto__"` never resolve to something on a prototype.
 */
export function defineReshapers(entries: Readonly<Record<string, Reshaper>>): ReshaperRegistry {
  const byName = new Map(Object.entries(entries));
  return { get: (name) => byName.get(name) };
}

/**
 * A Named reshaper runs in-process, trusted like host code — but the RAW terminal output is also
 * read by callers after `reshape` returns (output-shape hashing, drift sampling): a reshaper that
 * mutates its input in place must never corrupt what those later readers see, so it gets a copy,
 * never the original reference. A raw value `structuredClone` cannot represent anywhere in its
 * tree (a function; `structuredClone` throws) is REFUSED rather than handed to the reshaper live
 * — that would let the reshaper corrupt what later readers see, exactly what the copy exists to
 * prevent. (A class instance is not this case: `structuredClone` clones it fine, it just drops
 * the prototype, so the copy is a plain object with the same own properties.) Throws; `runNamed`
 * turns that into a `reshape-failed` finding before the reshaper ever runs.
 */
function cloneForReshaper(raw: unknown): unknown {
  try {
    return structuredClone(raw);
  } catch {
    throw new Error("input is not cloneable");
  }
}

async function runNamed(
  name: string,
  raw: unknown,
  registry: ReshaperRegistry | undefined
): Promise<ReshapeResult> {
  const fn = registry?.get(name);
  if (fn === undefined)
    return {
      ok: false,
      finding: {
        code: "reshape-unregistered",
        severity: "error",
        message:
          registry === undefined
            ? `reshaper "${name}" is Named, but no reshaper registry was supplied`
            : `no reshaper is registered under "${name}"`,
      },
    };
  let cloned: unknown;
  try {
    cloned = cloneForReshaper(raw);
  } catch (err) {
    return {
      ok: false,
      finding: {
        code: "reshape-failed",
        severity: "error",
        message: `reshaper "${name}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  try {
    return { ok: true, value: await fn(cloned) };
  } catch (err) {
    return {
      ok: false,
      failureKind: "named-threw",
      finding: {
        code: "reshape-failed",
        severity: "error",
        message: `reshaper "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

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
      failureKind: "selects-nothing",
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
    reshapers?: ReshaperRegistry;
  }
): Promise<ReshapeResult> {
  if (reshaping.engine === "JSONPath") return jsonPathSelect(raw, reshaping.scriptRef);
  if (reshaping.engine === "Named") return runNamed(reshaping.scriptRef, raw, ctx.reshapers);
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
    if (err instanceof TypedFailure) {
      const failureKind = sandboxFailureKind(err);
      return {
        ok: false,
        ...(failureKind !== undefined && { failureKind }),
        finding: {
          code: `reshape-${err.channel}`,
          severity: "error",
          message: `sandbox ${err.channel}: ${safeStringify(err.payload)}`,
        },
      };
    }
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
