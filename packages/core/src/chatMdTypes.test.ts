import { describe, expect, it } from "vitest";
import { destAt, markerAt, tickRuns } from "./chatMdScan";
import { MD_MAX_URL, mdPlainText, safeLinkHref } from "./chatMdTypes";

describe("safeLinkHref", () => {
  it("allows http, https and mailto, in any case", () => {
    expect(safeLinkHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeLinkHref("HTTP://Example.com")).toBe("HTTP://Example.com");
    expect(safeLinkHref("mailto:a@b.example")).toBe("mailto:a@b.example");
  });
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:x",
    "data:text/html,x",
    "vbscript:x",
    "file:///etc/passwd",
    "//evil.example",
    "/relative",
    "#fragment",
    "",
    "mailto:",
    "https://",
    "https:///path",
    "https://user:pw@evil.example/",
    "https://a@b.example/",
    "java\tscript:alert(1)",
    "https://a.example/ b",
    "https://a.example/\u0085",
    "https://a.example/\\b",
    `https://a.example/${"x".repeat(MD_MAX_URL)}`,
  ])("refuses %j", (raw) => expect(safeLinkHref(raw)).toBeUndefined());
});

describe("mdPlainText", () => {
  it("flattens inline nodes to text, a break to a space, and draws no marker", () => {
    expect(
      mdPlainText([
        { type: "text", text: "a " },
        { type: "strong", children: [{ type: "text", text: "b" }] },
        { type: "br" },
        { type: "link", href: "https://x.example", children: [{ type: "code", text: "c" }] },
        { type: "marker", id: "a1" },
      ])
    ).toBe("a b c");
  });
});

describe("scanning helpers", () => {
  it("markerAt reads [[id]] with a bounded id and nothing else", () => {
    expect(markerAt("x [[a_1.b:c-d]] y", 2)).toEqual({ id: "a_1.b:c-d", end: 15 });
    for (const t of [
      "[[]]",
      "[[ a ]]",
      "[[a b]]",
      "[a]",
      "[[-a]]",
      `[[${"a".repeat(129)}]]`,
      "[[a]",
    ])
      expect(markerAt(t, 0), t).toBeUndefined();
  });
  it("tickRuns indexes each backtick run with the next run of the same length", () => {
    expect(tickRuns("`a` ``b`` `c")).toEqual([
      { pos: 0, len: 1, next: 1 },
      { pos: 2, len: 1, next: 4 },
      { pos: 4, len: 2, next: 3 },
      { pos: 7, len: 2, next: -1 },
      { pos: 10, len: 1, next: -1 },
    ]);
  });
  it('destAt reads (dest "title"), balanced parentheses and <dest>, and says when the text ended first', () => {
    expect(destAt('[a](https://x.example/(p) "t") rest', 3)).toEqual({
      href: "https://x.example/(p)",
      end: 30,
    });
    expect(destAt("[a](<https://x.example/a b>)", 3)).toEqual({
      href: "https://x.example/a b",
      end: 28,
    });
    expect(destAt("[a](https://x.exam", 3)).toBe("eof");
    expect(destAt("[a](https://x.example/ b)", 3)).toBeUndefined();
    expect(destAt("[a](x)", 3)).toEqual({ href: "x", end: 6 });
  });
  it("finishes adversarial input with a result bounded by the input (no wall-clock assertion)", () => {
    const runs = tickRuns("`a ".repeat(30000));
    expect(runs).toHaveLength(30000);
    // every run is a single tick, so each one's "next" is the following run: a chain, built in one pass
    expect(runs.slice(0, -1).every((r, k) => r.next === k + 1)).toBe(true);
    expect(runs[29999]?.next).toBe(-1);
    for (let k = 0; k < 20; k++) expect(destAt(`(${"(".repeat(30000)}`, 0)).toBe("eof");
  });
});
