import { DEFAULT_STEP_KIND, STEP_KIND_PATTERN } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import type { TransientInvoker } from "./invoker";

// ── The data plane: a step's KIND names the DataProvider that runs it (U3) ───────
// A provider's graph steps used to be MCP tool calls and nothing else, so a loom app whose data
// lives in a loom tool, a read model or an A2A peer had to wrap it as an MCP server to bind a
// widget. A step now names a KIND (`step.kind`, absent = MCP); hydration looks the kind up in a
// `DataProviderRegistry` the HOST builds at composition time — there is no runtime plugin system,
// no discovery, no registering after the first load. MCP is the first registered kind and the
// default, and behaves byte-for-byte as before.
//
// What a kind supplies (`DataProvider.invoke`) is ONE call: run `target` with `args`, THROUGH the
// transient invoker hydration was given — which is what keeps the read path log-free and keeps
// the invoker's own authorisation, budget and per-principal identity (`opts.principal`) in force.
// A kind never gets a handle on the runtime, only the invoker. Everything else — waves, templates,
// params, reshaping, output checks, caching, finding vocabulary — is the kind-independent part and
// stays in `executeProvider`.
//
// THE PIN IS THE CONTRACT. Every step carries `toolSchemaHash` (required, non-empty): the kind's
// fingerprint of the target's input contract, taken when the step was authored. `invoke` MUST
// compare it with the target's current pin and, on a mismatch, throw
// `TypedFailure("schemaDrift", { observedHash })` BEFORE running the target. That is what makes
// drift detectable, repairable (`remapOperation` re-pins from `observedHash`) and what lets
// `inputDrift: "report-and-proceed"` retry once with the observed pin. A kind that cannot say what
// its target's contract currently is must not be registered: there is no "unpinned" kind. (MCP
// delegates the comparison to `mcp.invoke`, which verifies it per call; `loomEffectProvider` keeps
// the pins in a host-declared table.) `checkDataProviderConformance` asserts exactly this.

/** One call a kind is asked to make. */
export interface DataProviderCall {
  readonly stepId: string;
  /** The step's `toolName`: the target's id WITHIN this kind. */
  readonly target: string;
  /** The step's arguments, after params, time tokens, templates and the host's hook. */
  readonly args: Record<string, unknown>;
  /** The step's `toolSchemaHash`, or the observed pin on the one drift retry. */
  readonly expectedPin: string;
}

export interface DataProvider {
  /** The kind id steps name. Lower-case/digits/`-`; never `"mcp"` unless it IS the MCP provider. */
  readonly kind: string;
  /**
   * Run the call and return the raw output. Contract: throw `TypedFailure("schemaDrift",
   * { observedHash })` when `expectedPin` is not the target's current pin, before running it; any
   * other `TypedFailure` becomes a `tool-<channel>` finding, anything else `tool-failed`. All
   * calls MUST go through `invoker` with `opts` (it carries the signal and the principal).
   */
  invoke(
    call: DataProviderCall,
    invoker: TransientInvoker,
    opts: TransientInvokeOptions
  ): Promise<unknown>;
}

/** The kinds a host composed, by id. Immutable once built. */
export interface DataProviderRegistry {
  has(kind: string): boolean;
  get(kind: string): DataProvider | undefined;
  /** Registered kind ids, sorted. */
  kinds(): readonly string[];
}

/**
 * Build a registry. Refuses a malformed or duplicate kind id: two providers for one kind would
 * make what a stored experience means depend on registration order.
 */
export function defineDataProviders(providers: readonly DataProvider[]): DataProviderRegistry {
  const byKind = new Map<string, DataProvider>();
  for (const p of providers) {
    if (typeof p.kind !== "string" || !STEP_KIND_PATTERN.test(p.kind))
      throw new TypeError(`defineDataProviders: "${String(p.kind)}" is not a valid kind id`);
    if (byKind.has(p.kind))
      throw new TypeError(`defineDataProviders: kind "${p.kind}" is registered twice`);
    byKind.set(p.kind, p);
  }
  const sorted = Object.freeze([...byKind.keys()].sort());
  return {
    has: (kind) => byKind.has(kind),
    get: (kind) => byKind.get(kind),
    kinds: () => sorted,
  };
}

/** The MCP kind: `mcp.invoke` with the pin as `expectedSchemaHash` (the plugin verifies it per call). */
export const mcpProvider: DataProvider = Object.freeze<DataProvider>({
  kind: DEFAULT_STEP_KIND,
  invoke: (call, invoker, opts) =>
    invoker.invokeTransient(
      MCP_INVOKE_TOOL_ID,
      { toolName: call.target, args: call.args, expectedSchemaHash: call.expectedPin },
      opts
    ),
});

/** What `executeProvider` uses when the host registers nothing: MCP only — the behaviour before kinds. */
export const DEFAULT_DATA_PROVIDERS: DataProviderRegistry = defineDataProviders([mcpProvider]);

/**
 * Assert the one rule every kind must keep: a wrong pin is `schemaDrift` carrying the observed
 * pin, and the right pin runs the target. Run it in a kind's own test suite against a target the
 * kind serves (`target`, with its current `pin`) and a recording invoker. Returns a list of
 * violations (empty = conformant); never throws for a violation. A wrong pin must ALSO not reach
 * the target (a direct call to `target` through the invoker is counted). This is a TEST HELPER: `defineDataProviders`
 * cannot enforce the rule at registration, so a kind that skips this suite is unchecked.
 */
export async function checkDataProviderConformance(
  provider: DataProvider,
  fixture: { target: string; pin: string; invoker: TransientInvoker }
): Promise<string[]> {
  const problems: string[] = [];
  let reached = 0;
  const counting: TransientInvoker = {
    invokeTransient: (...a) => {
      // Only a call to the target's OWN id counts: the MCP kind reaches `mcp.invoke`, whose pin
      // check lives inside that effect (and is MCP's own conformance, not this kit's).
      if (a[0] === fixture.target) reached++;
      return fixture.invoker.invokeTransient(...a);
    },
  };
  const base = { stepId: "conformance", target: fixture.target, args: {} };
  try {
    await provider.invoke({ ...base, expectedPin: `${fixture.pin}-stale` }, counting, {});
    problems.push("a stale pin did not fail");
  } catch (e) {
    if (!(e instanceof TypedFailure && e.channel === "schemaDrift"))
      problems.push("a stale pin failed, but not as TypedFailure(schemaDrift)");
    else if ((e.payload as { observedHash?: string } | undefined)?.observedHash !== fixture.pin)
      problems.push("schemaDrift did not carry the target's current pin as observedHash");
  }
  if (reached > 0) problems.push("a stale pin reached the target before failing");
  try {
    await provider.invoke({ ...base, expectedPin: fixture.pin }, fixture.invoker, {});
  } catch (e) {
    problems.push(`the current pin did not run the target: ${e instanceof Error ? e.message : e}`);
  }
  return problems;
}
