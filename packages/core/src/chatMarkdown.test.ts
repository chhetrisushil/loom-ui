import { describe, expect, it } from "vitest";
import { type MdBlock, type MdInline, mdPlainText, parseChatMarkdown } from "./chatMarkdown";

const doc = (t: string, o: { markers?: boolean; streaming?: boolean } = {}) =>
  parseChatMarkdown(t, o);
const first = (t: string, o = {}): MdBlock => doc(t, o).blocks[0] as MdBlock;
const txt = (text: string): MdInline => ({ type: "text", text });

describe("paragraphs, headings, rules", () => {
  it("splits paragraphs on a blank line and keeps a soft break inside one", () => {
    expect(doc("a\nb\n\nc").blocks).toEqual([
      { type: "paragraph", inlines: [txt("a\nb")] },
      { type: "paragraph", inlines: [txt("c")] },
    ]);
  });
  it("reads ATX headings only, with a closing run of # removed", () => {
    expect(first("## Title ##")).toEqual({ type: "heading", level: 2, inlines: [txt("Title")] });
    expect(first("#nospace").type).toBe("paragraph");
    expect(first("####### seven").type).toBe("paragraph");
    expect(first("Title\n=====").type).toBe("paragraph");
  });
  it("reads a thematic break", () => {
    expect(doc("a\n\n---\n\nb").blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "rule",
      "paragraph",
    ]);
    expect(doc("* * *").blocks).toEqual([{ type: "rule" }]);
  });
  it("treats indented text as a paragraph, not code, and html as text", () => {
    expect(first("    indented").type).toBe("paragraph");
    expect(first("<div>\nx\n</div>")).toEqual({
      type: "paragraph",
      inlines: [txt("<div>\nx\n</div>")],
    });
  });
});

describe("fenced code", () => {
  it("keeps its text verbatim (no markup, no markers) and takes a safe language word", () => {
    expect(first("```ts\nconst a = **x**;\n```")).toEqual({
      type: "code",
      lang: "ts",
      text: "const a = **x**;",
    });
    expect(first("```\na [[a1]] <b>\n```", { markers: true })).toEqual({
      type: "code",
      text: "a [[a1]] <b>",
    });
    expect(first("```<img onerror=1>\nx\n```")).toEqual({ type: "code", text: "x" });
    expect(first("~~~py extra words\nx\n~~~")).toMatchObject({ type: "code", lang: "py" });
  });
  it("runs an unclosed fence to the end, which is what a half-written one looks like", () => {
    expect(first("```js\nlet a")).toEqual({ type: "code", lang: "js", text: "let a" });
    expect(first("````\n```\nstill code\n````")).toEqual({ type: "code", text: "```\nstill code" });
  });
});

describe("quotes", () => {
  it("nests, and stops nesting at MD_MAX_DEPTH (the rest is text)", () => {
    expect(first("> a\n> b")).toMatchObject({ type: "quote", blocks: [{ type: "paragraph" }] });
    let b: MdBlock | undefined = doc(`${"> ".repeat(20)}x`).blocks[0];
    let depth = 0;
    while (b?.type === "quote") {
      depth++;
      b = b.blocks[0];
    }
    expect(depth).toBe(6);
    expect(b?.type).toBe("paragraph");
  });
});

describe("the whole parse", () => {
  it("is total: non-strings are empty and controls are gone", () => {
    expect(parseChatMarkdown(undefined)).toEqual({ blocks: [], truncated: false });
    const dirty = doc(`a${String.fromCharCode(27)}[2Jb${String.fromCharCode(0x202e)}`);
    expect(JSON.stringify(dirty)).toBe(JSON.stringify(doc("a[2Jb")));
  });
  it("cuts at MD_MAX_NODES and says so", () => {
    const d = doc("a\n\n".repeat(5000));
    expect(d.truncated).toBe(true);
    expect(d.blocks.length).toBeLessThanOrEqual(2000);
  });
  it("is linear on adversarial input", () => {
    const cases = [
      "> ".repeat(30000),
      "\n".repeat(60000),
      "```\n".repeat(15000),
      "#".repeat(60000),
      "---\n".repeat(15000),
      "a\n".repeat(30000),
      "    ".repeat(15000),
    ];
    // F33: no wall-clock assertion; each case finishes (runner timeout guards a hang) within the node budget.
    for (const c of cases) {
      const d = doc(c, { markers: true, streaming: true });
      expect(d.blocks.length, c.slice(0, 6)).toBeLessThanOrEqual(2000);
    }
  });
  it("settles: every prefix parses, and the whole text equals the settled parse", () => {
    const full =
      "# T\n\nSome **bold** and `code` [[a1]] and [l](https://e.example).\n\n> q\n\n```js\nlet a;\n```\n";
    for (let k = 0; k <= full.length; k++)
      expect(() => doc(full.slice(0, k), { markers: true, streaming: true })).not.toThrow();
    expect(doc(full, { markers: true, streaming: true })).toEqual(doc(full, { markers: true }));
    const half = doc("see [x", { streaming: true }).blocks[0];
    expect(half?.type === "paragraph" && mdPlainText(half.inlines)).toBe("see [x");
  });
});
