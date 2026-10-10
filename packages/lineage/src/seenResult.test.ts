import { describe, expect, expectTypeOf, it } from "vitest";
import type { LineageResult, Refusal } from "./lineage";
import type { SeenRefusal, SeenResult } from "./seen";

describe("SeenResult is a LineageResult (follow-up 3b)", () => {
  it("a SeenResult / SeenRefusal is accepted where a LineageResult / Refusal is", () => {
    // These are the type-level proof; `pnpm typecheck:tests` is the gate (vitest does not typecheck).
    expectTypeOf<SeenRefusal>().toMatchTypeOf<Refusal>();
    expectTypeOf<SeenResult<number>>().toMatchTypeOf<LineageResult<number>>();
    const widen = <T>(r: SeenResult<T>): LineageResult<T> => r;
    const refused: SeenResult<number> = {
      ok: false,
      refusal: {
        kind: "refused",
        finding: { code: "seen-x", severity: "error", message: "m" },
        code: "seen-x",
        message: "m",
      },
    };
    const wide = widen(refused);
    // narrowing on the lineage discriminant works on a seen refusal, and the old fields remain
    if (wide.ok || wide.refusal.kind !== "refused") throw new Error("unreachable");
    expect(wide.refusal.finding.code).toBe("seen-x");
    expect((refused.ok === false && refused.refusal.code) || "").toBe("seen-x");
  });
});
