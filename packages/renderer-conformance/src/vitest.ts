import { describe, expect, it } from "vitest";
import type { RendererAdapter } from "./adapter";
import { CHECKS } from "./checks";
import { runCheck } from "./run";

/**
 * One `it` per check, under `describe("renderer conformance: <name>")`. A check the adapter does
 * not declare the capability for is reported as a pass with a skip note in its title — never a
 * silent omission — and `expectCapabilities` makes a skip a failure.
 */
export function describeRendererConformance(
  adapter: RendererAdapter,
  options: { readonly timeoutMs?: number; readonly forbidSkips?: boolean } = {}
): void {
  describe(`renderer conformance: ${adapter.name}`, () => {
    for (const c of CHECKS) {
      it(
        c.title,
        async () => {
          const r = await runCheck(c, adapter);
          if (r.status === "fail") expect.fail(`[${c.id}] ${r.message}`);
          if (r.status === "skip" && options.forbidSkips === true)
            expect.fail(`[${c.id}] skipped: ${r.message}`);
        },
        options.timeoutMs ?? 15_000
      );
    }
  });
}
