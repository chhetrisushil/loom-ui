import type { Finding, MCPToolNode, ProviderSpec } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import type { TransientInvoker } from "./invoker";
import { resolveArguments, terminalSteps, topoWaves } from "./plan";
import { outputShapeHashOf, reshape, safeStringify } from "./reshape";

// ── Executing one provider ────────────────────────────────────────────────────
// The transient interpreter (ADRs 0060–0066): walk the graph in waves, invoke `mcp.invoke` per
// step with the pinned input-schema hash, reshape the terminal output, check its shape. Zero
// events on this path. A pin that drifts is REPORTED, never re-run with the observed hash — the
// durable repair is the app's, and `remapOperation` (repair.ts) builds its operation.

export interface DriftRecord {
  readonly kind: "input" | "output";
  readonly handle: string;
  readonly stepId?: string;
  readonly toolName?: string;
  readonly expected: string;
  readonly observed: string;
}

export type ProviderOutcome =
  | { ok: true; value: unknown; findings: Finding[] }
  | { ok: false; finding: Finding; drift: DriftRecord[]; findings: Finding[] };

export interface ExecuteOptions {
  readonly invoker: TransientInvoker;
  readonly signal?: AbortSignal;
  readonly principal?: TransientInvokeOptions["principal"];
  /** Parallel steps per wave. Default 4. */
  readonly concurrency?: number;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });

export async function executeProvider(
  spec: ProviderSpec,
  opts: ExecuteOptions
): Promise<ProviderOutcome> {
  const findings: Finding[] = [];
  const drift: DriftRecord[] = [];
  const steps = spec.executionGraph;
  if (steps.length === 0)
    return {
      ok: false,
      finding: err("empty-graph", `provider "${spec.handle}" has no steps`),
      drift,
      findings,
    };
  const { waves, cycle } = topoWaves(steps);
  if (cycle.length > 0)
    return {
      ok: false,
      finding: err(
        "graph-cycle",
        `provider "${spec.handle}" has a dependency cycle through ${cycle.join(", ")}`
      ),
      drift,
      findings,
    };

  const outputs = new Map<string, unknown>();
  const failed = new Map<string, Finding>();
  const invokeOpts: TransientInvokeOptions = {
    label: "loom-ui.hydrate",
    ...(opts.signal && { signal: opts.signal }),
    ...(opts.principal && { principal: opts.principal }),
  };

  for (const wave of waves) {
    await mapLimit(wave, opts.concurrency ?? 4, async (node: MCPToolNode) => {
      if (opts.signal?.aborted) {
        failed.set(node.stepId, err("aborted", `step "${node.stepId}" aborted before it ran`));
        return;
      }
      if (node.dependsOn.some((d) => failed.has(d))) {
        failed.set(
          node.stepId,
          err("dependency-failed", `step "${node.stepId}" skipped: a dependency failed`)
        );
        return;
      }
      const args = resolveArguments(node, outputs);
      if (!args.ok) {
        failed.set(node.stepId, args.finding);
        return;
      }
      try {
        const out = await opts.invoker.invokeTransient(
          MCP_INVOKE_TOOL_ID,
          { toolName: node.toolName, args: args.args, expectedSchemaHash: node.toolSchemaHash },
          invokeOpts
        );
        outputs.set(node.stepId, out);
      } catch (e) {
        if (e instanceof TypedFailure && e.channel === "schemaDrift") {
          const p = e.payload as { observedHash?: string };
          drift.push({
            kind: "input",
            handle: spec.handle,
            stepId: node.stepId,
            toolName: node.toolName,
            expected: node.toolSchemaHash,
            observed: p.observedHash ?? "",
          });
          failed.set(
            node.stepId,
            err(
              "schema-drift",
              `step "${node.stepId}" (${node.toolName}) input schema drifted from ${node.toolSchemaHash} to ${p.observedHash ?? "?"}`
            )
          );
        } else if (e instanceof TypedFailure) {
          failed.set(
            node.stepId,
            err(
              `tool-${e.channel}`,
              `step "${node.stepId}" (${node.toolName}) failed on channel ${e.channel}: ${safeStringify(e.payload)}`
            )
          );
        } else if (opts.signal?.aborted) {
          failed.set(node.stepId, err("aborted", `step "${node.stepId}" aborted`));
        } else {
          failed.set(
            node.stepId,
            err(
              "tool-failed",
              `step "${node.stepId}" (${node.toolName}) failed: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      }
    });
  }

  // GRAPH order, not completion order: two independent steps that fail in a race must produce
  // the same finding list every run, or the surface's error text depends on which tool was slower.
  for (const step of steps) {
    const f = failed.get(step.stepId);
    if (f) findings.push(f);
  }
  if (failed.size > 0) {
    return {
      ok: false,
      finding: err(
        "provider-failed",
        `provider "${spec.handle}": ${failed.size} of ${steps.length} steps failed`
      ),
      drift,
      findings,
    };
  }

  const terminals = terminalSteps(steps);
  const raw =
    terminals.length === 1
      ? outputs.get((terminals[0] as MCPToolNode).stepId)
      : Object.fromEntries(terminals.map((t) => [t.stepId, outputs.get(t.stepId)]));

  const shaped = await reshape(spec.reshaping, raw, {
    invoker: opts.invoker,
    ...(opts.signal && { signal: opts.signal }),
    ...(opts.principal && { principal: opts.principal }),
  });
  if (!shaped.ok) {
    findings.push(shaped.finding);
    return { ok: false, finding: shaped.finding, drift, findings };
  }

  if (spec.outputShapeHash === "") {
    findings.push({
      code: "output-shape-unpinned",
      severity: "warn",
      message: `provider "${spec.handle}" declares no outputShapeHash; the value is unchecked`,
    });
    return { ok: true, value: shaped.value, findings };
  }
  // The shaped value is tool-authored: `shapeHash` refuses a nest past its depth cap (and any
  // value it cannot walk). An unhashable value is an UNVERIFIABLE one — reported as a failure,
  // never published as if the pin had matched, and never as a throw out of this total function.
  let observed: string;
  try {
    observed = outputShapeHashOf(shaped.value);
  } catch (e) {
    const f = err(
      "output-shape-unhashable",
      `provider "${spec.handle}" output cannot be shape-hashed, so the pinned ${spec.outputShapeHash} cannot be checked: ${e instanceof Error ? e.message : String(e)}`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  if (observed !== spec.outputShapeHash) {
    drift.push({ kind: "output", handle: spec.handle, expected: spec.outputShapeHash, observed });
    const f = err(
      "output-shape-drift",
      `provider "${spec.handle}" output shape ${observed} differs from the pinned ${spec.outputShapeHash}`
    );
    findings.push(f);
    return { ok: false, finding: f, drift, findings };
  }
  return { ok: true, value: shaped.value, findings };
}
