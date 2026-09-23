import { describe, expect, it } from "vitest";
import { isPlannerUsage, totalUsage } from "./usage";

describe("PlannerUsage", () => {
  it("isPlannerUsage accepts two non-negative safe integers and nothing else", () => {
    expect(isPlannerUsage({ inputTokens: 0, outputTokens: 12 })).toBe(true);
    for (const bad of [
      null,
      {},
      { inputTokens: -1, outputTokens: 1 },
      { inputTokens: 1.5, outputTokens: 1 },
      { inputTokens: Number.NaN, outputTokens: 1 },
      { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY },
      { inputTokens: "1", outputTokens: 1 },
    ])
      expect(isPlannerUsage(bad)).toBe(false);
  });
  it("isPlannerUsage never throws — a revoked proxy, or one as a count, is just not a usage", () => {
    const revoked = () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    expect(isPlannerUsage(revoked())).toBe(false);
    expect(isPlannerUsage({ inputTokens: revoked(), outputTokens: 1 })).toBe(false);
  });
  it("totalUsage sums the parts that report usage and is undefined when none do", () => {
    expect(totalUsage([])).toBeUndefined();
    expect(totalUsage([{}, {}])).toBeUndefined();
    expect(
      totalUsage([
        { usage: { inputTokens: 100, outputTokens: 20 } },
        {},
        { usage: { inputTokens: 5, outputTokens: 1 } },
      ])
    ).toEqual({ inputTokens: 105, outputTokens: 21 });
  });
});
