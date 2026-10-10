import type { CheckResult, ConformanceReport, RendererAdapter } from "./adapter";
import { CHECKS, type Check, ConformanceFailure, ConformanceSkip } from "./checks";

export interface RunOptions {
  /** Run only these check ids. Default: all. */
  readonly only?: readonly string[];
}

/** Run one check; a throw is a failure, a {@link ConformanceSkip} is a skip. Never throws. */
export async function runCheck(check: Check, adapter: RendererAdapter): Promise<CheckResult> {
  const base = { id: check.id, title: check.title };
  try {
    await check.run(adapter);
    return { ...base, status: "pass" };
  } catch (e) {
    if (e instanceof ConformanceSkip) return { ...base, status: "skip", message: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      status: "fail",
      message: e instanceof ConformanceFailure ? message : `renderer threw: ${message}`,
    };
  }
}

/**
 * Run the kit against an adapter. Framework-free: it returns a report; {@link
 * describeRendererConformance} (from `@loom-ui/renderer-conformance/vitest`) turns each check into a test.
 */
export async function checkRendererConformance(
  adapter: RendererAdapter,
  options: RunOptions = {}
): Promise<ConformanceReport> {
  const results: CheckResult[] = [];
  for (const c of CHECKS) {
    if (options.only !== undefined && !options.only.includes(c.id)) continue;
    results.push(await runCheck(c, adapter));
  }
  const failed = results.filter((r) => r.status === "fail");
  return {
    adapter: adapter.name,
    results,
    ok: failed.length === 0,
    failed,
    skipped: results.filter((r) => r.status === "skip"),
  };
}
