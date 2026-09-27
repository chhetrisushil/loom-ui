import { describe, expect, it } from "vitest";
import { addUsage, isPlannerUsage, readReportedUsage, snapshotUsage, totalUsage } from "./usage";

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
  it("snapshotUsage reads each count once into a fresh copy, and never throws", () => {
    let reads = 0;
    const flip = {
      get inputTokens() {
        reads += 1;
        return reads === 1 ? 3 : Number.NaN;
      },
      outputTokens: 1,
    };
    expect(snapshotUsage(flip)).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(reads).toBe(1);
    const { proxy, revoke } = Proxy.revocable({ inputTokens: 1, outputTokens: 1 }, {});
    revoke();
    for (const bad of [undefined, null, "x", 7, { inputTokens: "a", outputTokens: 1 }, proxy])
      expect(snapshotUsage(bad)).toBeUndefined();
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

  describe("readReportedUsage", () => {
    it("absent or null usage is unreported: {}", () => {
      expect(readReportedUsage({})).toEqual({});
      expect(readReportedUsage({ usage: null })).toEqual({});
    });
    it("two non-negative safe integers are returned as a fresh usage, -0 normalised to 0", () => {
      expect(readReportedUsage({ usage: { inputTokens: 3, outputTokens: 4 } })).toEqual({
        usage: { inputTokens: 3, outputTokens: 4 },
      });
      const r = readReportedUsage({ usage: { inputTokens: -0, outputTokens: 1 } });
      expect(Object.is(r.usage?.inputTokens, 0)).toBe(true);
    });
    it("extra fields on usage are dropped — only the two counts survive", () => {
      expect(
        readReportedUsage({ usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.1 } })
      ).toStrictEqual({ usage: { inputTokens: 3, outputTokens: 4 } });
    });
    it("a non-object usage, or an invalid count, is a problem naming the KIND, never the value", () => {
      expect(readReportedUsage({ usage: "x".repeat(1000) }).problem).toBe(
        "usage is a string, not an object"
      );
      const bad = readReportedUsage({ usage: { inputTokens: "huge-value", outputTokens: 1 } });
      expect(bad.problem).toBe("inputTokens is a string");
      expect(bad.problem).not.toContain("huge-value");
      expect(bad.usage).toBeUndefined();
    });
    it("a throwing getter on usage, or on a count, is a problem — never throws", () => {
      expect(
        readReportedUsage({
          get usage(): unknown {
            throw new Error("boom");
          },
        }).problem
      ).toBeDefined();
      expect(
        readReportedUsage({
          usage: {
            get inputTokens(): number {
              throw new Error("boom");
            },
            outputTokens: 1,
          },
        }).problem
      ).toBeDefined();
    });
    it("a revoked proxy as usage, or as a count, is a problem — never throws", () => {
      const revoked = () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      };
      expect(readReportedUsage({ usage: revoked() }).problem).toBeDefined();
      expect(
        readReportedUsage({ usage: { inputTokens: revoked(), outputTokens: 1 } }).problem
      ).toBeDefined();
    });
  });

  describe("addUsage", () => {
    it("sums both fields when the total stays a safe integer", () => {
      expect(
        addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })
      ).toEqual({ total: { inputTokens: 4, outputTokens: 6 } });
    });
    it("refuses rather than overflow, leaving the total unchanged", () => {
      const total = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 };
      const added = addUsage(total, { inputTokens: 1, outputTokens: 0 });
      expect(added.total).toStrictEqual(total);
      expect(added.refused).toBeDefined();
      expect(isPlannerUsage(added.total)).toBe(true);
    });
    it("refuses on either field independently", () => {
      const total = { inputTokens: 1, outputTokens: Number.MAX_SAFE_INTEGER };
      expect(addUsage(total, { inputTokens: 0, outputTokens: 1 }).refused).toBeDefined();
    });
    it("the exact boundary (total lands ON MAX_SAFE_INTEGER) is not a refusal", () => {
      const total = { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 };
      const added = addUsage(total, { inputTokens: 1, outputTokens: 0 });
      expect(added.refused).toBeUndefined();
      expect(added.total).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    });
  });
});
