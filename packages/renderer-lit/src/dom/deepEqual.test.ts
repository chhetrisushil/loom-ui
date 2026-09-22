import { describe, expect, it } from "vitest";
import { deepEqual } from "./deepEqual";

describe("deepEqual", () => {
  it("compares primitives, arrays and plain objects structurally, key order ignored", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: 1, b: { c: [1] } }, { b: { c: [1] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(false);
  });
  it("distinguishes null, undefined, arrays and objects", () => {
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
  });
  it("treats functions and other non-plain values by reference", () => {
    const f = () => 1;
    expect(deepEqual({ f }, { f })).toBe(true);
    expect(deepEqual({ f }, { f: () => 1 })).toBe(false);
  });
});
