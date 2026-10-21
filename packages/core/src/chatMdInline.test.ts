import { describe, expect, it } from "vitest";
import { parseInlines } from "./chatMdInline";
import { MD_MAX_NODES, type MdInline, mdPlainText } from "./chatMdTypes";

const inl = (t: string, o: { markers?: boolean; streaming?: boolean } = {}): readonly MdInline[] =>
  parseInlines(t, {
    nodes: 0,
    truncated: false,
    markers: o.markers === true,
    streaming: o.streaming === true,
  });
const txt = (text: string): MdInline => ({ type: "text", text });

describe("code spans", () => {
  it("takes no markup inside a code span, and strips one padding space", () => {
    expect(inl("`**a** [[a1]] <b>`", { markers: true })).toEqual([
      { type: "code", text: "**a** [[a1]] <b>" },
    ]);
    expect(inl("`` a`b ``")).toEqual([{ type: "code", text: "a`b" }]);
  });
  it("leaves an unmatched backtick run as the literal characters", () => {
    expect(inl("open `tick and ``two")).toEqual([txt("open `tick and ``two")]);
  });
});

describe("escapes, breaks, html", () => {
  it("handles backslash escapes and hard breaks, and keeps a soft break", () => {
    expect(inl("\\*a\\* \\q")).toEqual([txt("*a* \\q")]);
    expect(inl("a  \nb")).toEqual([txt("a"), { type: "br" }, txt("b")]);
    expect(inl("a\\\nb")).toEqual([txt("a"), { type: "br" }, txt("b")]);
    expect(inl("a\nb")).toEqual([txt("a\nb")]);
  });
  it("never reads html or entities", () => {
    const t = "<b>x</b> &amp; <script>alert(1)</script> <img src=x onerror=1>";
    expect(inl(t)).toEqual([txt(t)]);
  });
});

describe("links and images", () => {
  it("makes a link only for an allowed address", () => {
    expect(inl('[docs](https://example.com/a?b=1 "t")')).toEqual([
      { type: "link", href: "https://example.com/a?b=1", children: [txt("docs")] },
    ]);
    expect(inl("[**m**](mailto:a@b.example)")[0]).toMatchObject({
      type: "link",
      href: "mailto:a@b.example",
    });
    expect(inl("[x](https://a.example/(p))")[0]).toMatchObject({ href: "https://a.example/(p)" });
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:x",
    "data:text/html,x",
    "//evil.example",
    "/rel",
    "#frag",
    "https://u:p@evil.example/",
    "java\tscript:x",
    "file:///etc/passwd",
  ])("keeps only the label for %j", (bad) => {
    const out = inl(`[click](${bad})`);
    expect(out.map((n) => n.type)).not.toContain("link");
    expect(mdPlainText(out)).toBe("click");
  });
  it("never links a bare address or a bracket without one, and never nests links", () => {
    expect(inl("see https://example.com bare")).toEqual([txt("see https://example.com bare")]);
    expect(inl("[x]")).toEqual([txt("[x]")]);
    expect(
      inl("[a [b](https://x.example) c](https://y.example)").filter((n) => n.type === "link")
    ).toHaveLength(1);
  });
  it("shows an image as its alt text and carries no address", () => {
    expect(inl("![a chart](https://tracker.example/p.png)")).toEqual([txt("a chart")]);
    expect(JSON.stringify(inl("![x](https://tracker.example/p.png?d=secret)"))).not.toContain(
      "tracker"
    );
  });
});

describe("reference markers", () => {
  it("are text unless the source writes them, never inside code, and not inside a link label", () => {
    expect(inl("a [[a1]] b")).toEqual([txt("a [[a1]] b")]);
    expect(inl("a [[a1]] b", { markers: true })).toEqual([
      txt("a "),
      { type: "marker", id: "a1" },
      txt(" b"),
    ]);
    expect(inl("x [[a_b.c:d-e]]", { markers: true })).toEqual([
      txt("x "),
      { type: "marker", id: "a_b.c:d-e" },
    ]);
    const link = inl("[see [[a1]]](https://x.example)", { markers: true })[0];
    expect(link).toMatchObject({ type: "link" });
    expect(JSON.stringify(link)).not.toContain("marker");
    expect(inl("[[ a1 ]] [[]] [[a b]]", { markers: true }).every((n) => n.type !== "marker")).toBe(
      true
    );
  });
});

describe("streaming", () => {
  it("does not draw a half-written marker", () => {
    expect(inl("Due [[a1", { markers: true, streaming: true })).toEqual([txt("Due")]);
    expect(inl("Due [[", { markers: true, streaming: true })).toEqual([txt("Due")]);
    expect(inl("Due [[a1]", { markers: true, streaming: true })).toEqual([txt("Due")]);
    expect(inl("Due [", { markers: true, streaming: true })).toEqual([txt("Due [")]);
    expect(inl("Due [[a1", { markers: true })).toEqual([txt("Due [[a1")]);
  });
  it("draws only the label of a half-written link, then the link when it is whole", () => {
    for (const t of [
      "see [the doc",
      "see [the doc]",
      "see [the doc](http",
      "see [the doc](https://exam",
    ]) {
      const s = mdPlainText(inl(t, { streaming: true }));
      expect(s.includes("](") || s.includes("http"), t).toBe(false);
    }
    expect(mdPlainText(inl("see [the doc]", { streaming: true }))).toBe("see the doc");
    expect(mdPlainText(inl("see [the doc]", { streaming: false }))).toBe("see [the doc]");
    expect(inl("see [the doc](https://e.example)", { streaming: true })[1]).toMatchObject({
      type: "link",
    });
  });
  it("settles: every prefix parses, and the whole text equals the settled parse", () => {
    const full = "Some **bold** and `code` [[a1]] and [l](https://e.example) ok.";
    for (let k = 0; k <= full.length; k++)
      expect(() => inl(full.slice(0, k), { markers: true, streaming: true })).not.toThrow();
    expect(inl(full, { markers: true, streaming: true })).toEqual(inl(full, { markers: true }));
  });
});

describe("bounds", () => {
  it("is linear on adversarial input", () => {
    const cases = [
      "*a ".repeat(30000),
      "[".repeat(60000),
      "`a ".repeat(20000),
      "[[".repeat(30000),
      "_*".repeat(30000),
      "[a](".repeat(15000),
      "![".repeat(30000),
      "a  \n".repeat(15000),
      "**".repeat(30000),
      "((((".repeat(15000),
      "[a](<".repeat(10000),
      "*a*".repeat(20000),
      "[a]".repeat(20000),
    ];
    // F33: no wall-clock assertion. Each case must finish (the runner's timeout is the guard against a hang) with a
    // result bounded by the input and the node budget; a quadratic scan on 60 000 characters would not finish.
    for (const c of cases) {
      const st = { nodes: 0, truncated: false, markers: true, streaming: true };
      const out = parseInlines(c, st);
      expect(st.nodes, c.slice(0, 6)).toBeLessThanOrEqual(MD_MAX_NODES);
      expect(mdPlainText(out).length, c.slice(0, 6)).toBeLessThanOrEqual(c.length);
    }
  });
  it("charges every node to the budget and cuts the rest", () => {
    const st = { nodes: 0, truncated: false, markers: false, streaming: false };
    const out = parseInlines("`a` ".repeat(5000), st);
    expect(st.truncated).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MD_MAX_NODES);
  });
});
