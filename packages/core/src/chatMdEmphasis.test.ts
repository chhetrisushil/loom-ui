import { describe, expect, it } from "vitest";
import { parseInlines } from "./chatMdInline";
import { type MdInline, mdPlainText } from "./chatMdTypes";

const inl = (t: string, o: { markers?: boolean; streaming?: boolean } = {}): readonly MdInline[] =>
  parseInlines(t, {
    nodes: 0,
    truncated: false,
    markers: o.markers === true,
    streaming: o.streaming === true,
  });
const txt = (text: string): MdInline => ({ type: "text", text });

describe("emphasis", () => {
  it("em and strong, with * and _", () => {
    expect(inl("a *b* **c** _e_ __f__")).toEqual([
      txt("a "),
      { type: "em", children: [txt("b")] },
      txt(" "),
      { type: "strong", children: [txt("c")] },
      txt(" "),
      { type: "em", children: [txt("e")] },
      txt(" "),
      { type: "strong", children: [txt("f")] },
    ]);
    expect(inl("***x***")).toEqual([
      { type: "em", children: [{ type: "strong", children: [txt("x")] }] },
    ]);
  });
  it("does not emphasise inside a word with _, or a lone *", () => {
    expect(inl("snake_case_word 2*3*4")).toEqual([
      txt("snake_case_word 2"),
      { type: "em", children: [txt("3")] },
      txt("4"),
    ]);
    expect(inl("a * b * c")).toEqual([txt("a * b * c")]);
  });
  it("leaves an unmatched delimiter as the literal characters", () => {
    expect(inl("**open and `tick")).toEqual([txt("**open and `tick")]);
    expect(inl("**a*")).toEqual([txt("*"), { type: "em", children: [txt("a")] }]);
    expect(inl("*a **b")).toEqual([txt("*a **b")]);
  });
  it("takes no emphasis inside a code span", () => {
    expect(inl("`**a**` **b**")).toEqual([
      { type: "code", text: "**a**" },
      txt(" "),
      { type: "strong", children: [txt("b")] },
    ]);
  });
  it("works inside a link label and around a reference marker", () => {
    expect(inl("[**m**](mailto:a@b.example)")).toEqual([
      {
        type: "link",
        href: "mailto:a@b.example",
        children: [{ type: "strong", children: [txt("m")] }],
      },
    ]);
    expect(inl("**x [[a_b]]**", { markers: true })).toEqual([
      { type: "strong", children: [txt("x "), { type: "marker", id: "a_b" }] },
    ]);
  });
  it("caps nesting", () => {
    const deep = inl(`${"**c ".repeat(10)}x${" c**".repeat(10)}`);
    const depth = (ns: readonly MdInline[]): number =>
      Math.max(0, ...ns.map((n) => ("children" in n ? 1 + depth(n.children) : 0)));
    expect(depth(deep)).toBeLessThanOrEqual(4);
  });
  it("is linear on adversarial delimiters, and caps the runs it resolves", () => {
    // F33: no wall-clock assertion; each case finishes (runner timeout guards a hang) with output bounded by the input.
    for (const c of [
      "*a ".repeat(30000),
      "_*".repeat(30000),
      "**".repeat(30000),
      "*a*".repeat(20000),
      "*a _b ".repeat(10000),
    ])
      expect(mdPlainText(inl(c)).length, c.slice(0, 6)).toBeLessThanOrEqual(c.length);
    const literal = inl("*a*".repeat(300)).filter((n) => n.type === "em").length;
    expect(literal).toBeLessThanOrEqual(100);
  });
});
