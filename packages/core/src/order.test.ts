import { describe, expect, it } from "vitest";
import { orderKeyAfterAll, orderKeyBetween } from "./order";

describe("orderKeyBetween", () => {
  it("returns a key strictly between two bounds", () => {
    const k = orderKeyBetween("a", "c");
    expect(k > "a" && k < "c").toBe(true);
  });
  it("prepends before -∞ and appends after +∞", () => {
    expect(orderKeyBetween(null, "a") < "a").toBe(true);
    expect(orderKeyBetween("a", null) > "a").toBe(true);
  });
  it("descends when the bounds are adjacent", () => {
    const k = orderKeyBetween("a", "b");
    expect(k > "a" && k < "b").toBe(true);
    expect(k.length).toBeGreaterThan(1);
  });
  it("throws when the lower bound is not below the upper (programmer error)", () => {
    expect(() => orderKeyBetween("b", "a")).toThrow(/not </);
    expect(() => orderKeyBetween("a", "a")).toThrow(/not </);
  });
});

describe("orderKeyAfterAll", () => {
  it("sorts after every sibling, and after nothing when there are none", () => {
    const k = orderKeyAfterAll([{ order: "V" }, { order: "a" }, { order: "Q" }]);
    expect(k > "a").toBe(true);
    expect(orderKeyAfterAll([]).length).toBeGreaterThan(0);
  });
});
