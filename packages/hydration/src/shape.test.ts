import { shapeHash } from "@loom/plugin-sandbox";
import { describe, expect, it } from "vitest";
import { outputShapeHashOf } from "./shape";

// `outputShapeHashOf` (client-safe) mirrors the sandbox's `shapeHash`; a planner pins with the
// former and the server compares with the latter, so they must agree on everything.
describe("outputShapeHashOf agrees with the sandbox shapeHash", () => {
  const corpus: unknown[] = [
    null,
    1,
    "x",
    true,
    undefined,
    [],
    {},
    [1, "a", 2, null],
    { a: 1, b: { c: [1, 2, { d: "x" }] }, e: undefined },
    [{ a: 1 }, { a: 2 }, { b: 1 }, { a: "s" }],
    {
      rows: [
        { id: 1, tags: ["a"] },
        { id: 2, tags: [] },
      ],
    },
  ];
  it.each(corpus.map((v, i) => [i, v] as const))("case %i", (_i, v) => {
    expect(outputShapeHashOf(v)).toBe(shapeHash(v));
  });
  it("refuses a pathologically deep value like the sandbox does", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1100; i++) deep = [deep];
    expect(() => outputShapeHashOf(deep)).toThrow(/depth limit/);
  });
});
