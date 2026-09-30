import { HYDRATION_VALUES_PREFIX as CORE_PREFIX, hydrationPath } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { HYDRATION_VALUES_PREFIX, handleOfPath } from "./path";

describe("handleOfPath", () => {
  it("pins the client's prefix to core's (two definitions, one value)", () => {
    expect(HYDRATION_VALUES_PREFIX).toBe(CORE_PREFIX);
  });

  it("is the exact inverse of core's hydrationPath", () => {
    const handles = [
      "latency-p99",
      "h",
      "a.b",
      "a.b.c",
      "values",
      "values.values",
      "x:h",
      "with space",
      ".lead",
      "trail.",
      "ünï",
    ];
    for (const h of handles) expect(handleOfPath(hydrationPath(h))).toBe(h);
  });

  it("returns undefined for anything not under the prefix", () => {
    for (const p of [
      "",
      "values",
      "values.",
      "status.h",
      "valuesh",
      "values-h",
      "values:h",
      "Values.h",
      " values.h",
      "xvalues.h",
      "h",
    ]) {
      expect(handleOfPath(p)).toBeUndefined();
    }
  });
});
