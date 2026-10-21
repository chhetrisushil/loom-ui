import { describe, expect, it } from "vitest";
import { type MdBlock, type MdInline, parseChatMarkdown } from "./chatMarkdown";

const doc = (t: string) => parseChatMarkdown(t);
const first = (t: string): MdBlock => doc(t).blocks[0] as MdBlock;
const txt = (text: string): MdInline => ({ type: "text", text });

describe("lists", () => {
  it("reads bullet and ordered lists, with the first number kept", () => {
    expect(first("- a\n- b")).toEqual({
      type: "list",
      ordered: false,
      start: 1,
      items: [
        [{ type: "paragraph", inlines: [txt("a")] }],
        [{ type: "paragraph", inlines: [txt("b")] }],
      ],
    });
    expect(first("3. x\n4. y")).toMatchObject({ type: "list", ordered: true, start: 3 });
    expect(doc("- a\n\n- b").blocks).toHaveLength(1);
  });
  it("nests by indentation, even two spaces under a numbered item", () => {
    const l = first("- a\n- b\n  - c\n- d");
    expect(l.type === "list" && l.items).toHaveLength(3);
    expect(l.type === "list" && (l.items[1] as MdBlock[]).map((b) => b.type)).toEqual([
      "paragraph",
      "list",
    ]);
    expect(doc("1. a\n  - sub\n2. b").blocks).toHaveLength(1);
  });
  it("lets a line continue its item, and a different marker start a new list", () => {
    const l = first("- one\ncontinues\n- two");
    expect(l.type === "list" && l.items).toHaveLength(2);
    expect(doc("- a\n* b").blocks).toHaveLength(2);
    expect(doc("- a\n\npara").blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });
  it("interrupts a paragraph for a bullet or for 1., but not for 2.", () => {
    expect(doc("text\n- a").blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    expect(doc("text\n1. a").blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    expect(doc("year\n2024. was").blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });
  it("holds code, quotes and markers in an item as it would anywhere else", () => {
    const l = first("- a\n  ```\n  x\n  ```\n  > q");
    expect(l.type === "list" && (l.items[0] as MdBlock[]).map((b) => b.type)).toEqual([
      "paragraph",
      "code",
      "quote",
    ]);
  });
  it("stops nesting at MD_MAX_DEPTH and is linear", () => {
    let b: MdBlock | undefined = first(`${"- ".repeat(20)}x`);
    let depth = 0;
    while (b?.type === "list") {
      depth++;
      b = (b.items[0] as MdBlock[])[0];
    }
    expect(depth).toBe(6);
    // F33: no wall-clock assertion; each case finishes (runner timeout guards a hang) within the node budget.
    for (const c of [
      "- ".repeat(30000),
      `${"1. a\n  ".repeat(8000)}`,
      "-\n".repeat(30000),
      "- a\n".repeat(30000),
    ])
      expect(doc(c).blocks.length, c.slice(0, 6)).toBeLessThanOrEqual(2000);
  });
});

describe("tables", () => {
  it("reads a header, an alignment row and rows, padding or cutting each row to the header's width", () => {
    const t = first("| a | b |\n|:--|--:|\n| 1 | 2 | 3 |\n| 4 |");
    expect(t).toMatchObject({
      type: "table",
      align: ["left", "right"],
      head: [[txt("a")], [txt("b")]],
    });
    expect(t.type === "table" && t.rows).toEqual([
      [[txt("1")], [txt("2")]],
      [[txt("4")], []],
    ]);
    expect(first("a | b\n--|--\n1 | 2").type).toBe("table");
    expect(first("| a |\n|:-:|\n| `x\\|y` |")).toMatchObject({ align: ["center"] });
  });
  it("needs an alignment row of the same width, else it is a paragraph", () => {
    expect(first("| a | b |\n| - |").type).toBe("paragraph");
    expect(first("| a | b |\n|---|---|---|").type).toBe("paragraph");
    expect(first("| a | b |\nnot a row").type).toBe("paragraph");
  });
  it("is bounded in columns and rows", () => {
    expect(first(`${"|a".repeat(13)}|\n${"|-".repeat(13)}|`).type).toBe("paragraph");
    const big = parseChatMarkdown(`|a|\n|-|\n${"|x|\n".repeat(150)}`);
    expect(big.truncated).toBe(true);
    const table = big.blocks[0];
    expect(table?.type === "table" && table.rows.length).toBe(100);
  });
  it("ends at a blank line, and its cells take inline markup but no html", () => {
    expect(doc("|a|\n|-|\n|**b**|\n\ntext").blocks.map((b) => b.type)).toEqual([
      "table",
      "paragraph",
    ]);
    const t = first("|a|\n|-|\n|<b>x</b>|");
    expect(t.type === "table" && t.rows[0]).toEqual([[txt("<b>x</b>")]]);
  });
});
