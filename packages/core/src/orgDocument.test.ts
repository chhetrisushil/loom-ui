import { describe, expect, it } from "vitest";
import { parseOrgDocument, parseOrgDocumentWith } from "./orgDocument";

const blocks = (t: string) => parseOrgDocument(t).blocks;
const t = (text: string) => ({ type: "text", text });

describe("parseOrgDocument blocks", () => {
  it("headlines become headings 1-6, dropping TODO, priority and tags", () => {
    expect(blocks("* TODO [#A] Plan the week :work:urgent:\n******* deep")).toEqual([
      { type: "heading", level: 1, inlines: [t("Plan the week")] },
      { type: "heading", level: 6, inlines: [t("deep")] },
    ]);
  });
  it("#+TITLE is a level-1 heading; other keywords and comments are dropped", () => {
    expect(blocks("#+TITLE: Notes\n#+AUTHOR: me\n# a comment\nbody")).toEqual([
      { type: "heading", level: 1, inlines: [t("Notes")] },
      { type: "paragraph", inlines: [t("body")] },
    ]);
  });
  it("emphasis: bold, italic, verbatim, code; underline and strike stay text", () => {
    expect(blocks("*b* /i/ =v= ~c~ _u_ +s+")).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "strong", children: [t("b")] },
          t(" "),
          { type: "em", children: [t("i")] },
          t(" "),
          { type: "code", text: "v" },
          t(" "),
          { type: "code", text: "c" },
          t(" _u_ +s+"),
        ],
      },
    ]);
  });
  it("a marker inside a word is text", () => {
    expect(blocks("a*b*c 2/3/4")).toEqual([{ type: "paragraph", inlines: [t("a*b*c 2/3/4")] }]);
  });
  it("links: [[url][label]] and [[url]]; unsafe schemes keep only their label", () => {
    expect(
      blocks(
        "[[https://a.example/x][the site]] [[mailto:me@a.example]] [[javascript:alert(1)][bad]]"
      )
    ).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "link", href: "https://a.example/x", children: [t("the site")] },
          t(" "),
          { type: "link", href: "mailto:me@a.example", children: [t("mailto:me@a.example")] },
          t(" bad"),
        ],
      },
    ]);
  });
  it("lists: - + bullets and 1. 1) ordered", () => {
    expect(blocks("- a\n+ b\n\n3. x\n4) y")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [{ type: "paragraph", inlines: [t("a")] }],
          [{ type: "paragraph", inlines: [t("b")] }],
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          [{ type: "paragraph", inlines: [t("x")] }],
          [{ type: "paragraph", inlines: [t("y")] }],
        ],
      },
    ]);
  });
  it("SRC and EXAMPLE blocks are code; QUOTE is a quote", () => {
    expect(
      blocks(
        "#+BEGIN_SRC python\nprint(1)\n#+END_SRC\n#+begin_example\nraw *x*\n#+end_example\n#+BEGIN_QUOTE\nsaid /so/\n#+END_QUOTE"
      )
    ).toEqual([
      { type: "code", lang: "python", text: "print(1)" },
      { type: "code", text: "raw *x*" },
      {
        type: "quote",
        blocks: [{ type: "paragraph", inlines: [t("said "), { type: "em", children: [t("so")] }] }],
      },
    ]);
  });
  it("tables: the row above |---+---| is the head", () => {
    expect(blocks("| a | b |\n|---+---|\n| 1 | 2 |")).toEqual([
      {
        type: "table",
        align: [null, null],
        head: [[t("a")], [t("b")]],
        rows: [[[t("1")], [t("2")]]],
      },
    ]);
  });
  it("a table without a rule has no head row: every row is a body row under an empty head", () => {
    expect(blocks("| 1 | 2 |")).toEqual([
      { type: "table", align: [null, null], head: [[], []], rows: [[[t("1")], [t("2")]]] },
    ]);
  });
  it("five or more dashes are a rule", () => {
    expect(blocks("-----")).toEqual([{ type: "rule" }]);
  });
  it("drawers and planning lines are dropped", () => {
    expect(blocks("* H\nSCHEDULED: <2026-10-24>\n:PROPERTIES:\n:ID: x\n:END:\nbody")).toEqual([
      { type: "heading", level: 1, inlines: [t("H")] },
      { type: "paragraph", inlines: [t("body")] },
    ]);
  });
  it("an unclosed block runs to the end", () => {
    expect(blocks("#+BEGIN_SRC\nx")).toEqual([{ type: "code", text: "x" }]);
  });
});

describe("parseOrgDocument ranges and bounds", () => {
  it("every top-level block has its source range", () => {
    const text = "* H\n\npara\nmore\n\n#+BEGIN_SRC\nx\n#+END_SRC";
    const d = parseOrgDocument(text);
    expect(d.ranges.map((r) => text.slice(r.from, r.to))).toEqual([
      "* H",
      "para\nmore",
      "#+BEGIN_SRC\nx\n#+END_SRC",
    ]);
  });
  it("is total on non-strings", () => {
    expect(parseOrgDocument(null)).toEqual({ blocks: [], ranges: [], truncated: false });
  });
  it("ranges stay parallel to blocks and a huge table does not throw", () => {
    const d = parseOrgDocument(`| a |\n${"| 1 |\n".repeat(200_000)}\n\npara`);
    expect(d.ranges).toHaveLength(d.blocks.length);
  });
  const gens: Record<string, (k: number) => string> = {
    "open bold": (k) => "*a ".repeat(k),
    "open links": (k) => "[[".repeat(k),
    paragraphs: (k) => "p\n\n".repeat(k),
    "nested emphasis": (k) => "*/".repeat(k),
    "table rows": (k) => `| a |\n|---|\n${"| 1 |\n".repeat(k)}`,
  };
  for (const [name, mk] of Object.entries(gens)) {
    it(`work stays near-linear: ${name}`, () => {
      const run = (s: string) => {
        const meter = { steps: 0 };
        parseOrgDocumentWith(s, meter);
        return meter.steps;
      };
      const a = run(mk(4000));
      const b = run(mk(8000));
      expect(b).toBeLessThanOrEqual(2.5 * Math.max(a, 1));
    });
  }
});
