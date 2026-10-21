import { describe, expect, it } from "vitest";
import { parseChatMarkdown, resolveMdMarkers } from "./chatMarkdown";
import { MD_MAX_CHARS, chatMarkdownLines } from "./chatMdText";
import type { MdDoc } from "./chatMdTypes";

const lines = (t: string, o: { known?: string[]; hideAll?: boolean } = {}) =>
  chatMarkdownLines(
    resolveMdMarkers(parseChatMarkdown(t, { markers: true }), new Set(o.known ?? []), {
      hideAll: o.hideAll === true,
    })
  );

describe("chatMarkdownLines", () => {
  it("reads as plain text, link targets shown, markers numbered", () => {
    const src =
      "# Terms\n\nDue in **30 days** [[a1]] see [docs](https://example.com/a) or `x`.\n\n- one\n- two\n  - sub\n\n1. a\n2. b\n\n> quoted\n\n| h1 | h2 |\n|---|---|\n| 1 | a\\|b |\n\n```js\nlet a = 1;\n```\n\n---";
    expect(lines(src, { known: ["a1"] })).toEqual([
      "# Terms",
      "",
      "Due in **30 days** [1] see docs (https://example.com/a) or `x`.",
      "",
      "- one",
      "- two",
      "  - sub",
      "",
      "1. a",
      "2. b",
      "",
      "> quoted",
      "",
      "| h1 | h2 |",
      "| --- | --- |",
      "| 1 | a\\|b |",
      "",
      "| let a = 1;",
      "",
      "---",
    ]);
  });
  it("shows no unsafe link target, no image address, no marker that is not listed", () => {
    const out = lines(
      "[x](javascript:alert(1)) ![alt](https://t.example/p.png) [[zzz]] <b>h</b>"
    ).join("\n");
    expect(out).toBe("x alt <b>h</b>");
  });
  it("is bounded in lines and in line length, and says so", () => {
    const many = chatMarkdownLines(parseChatMarkdown("- a\n".repeat(500)));
    expect(many).toHaveLength(201);
    expect(many.at(-1)).toBe("…");
    expect(chatMarkdownLines(parseChatMarkdown("x".repeat(60000)))[0]?.length).toBeLessThanOrEqual(
      2000
    );
  });
  it("never carries a control character", () => {
    const out = lines("a\u001b[2J `b\u0007` [c](https://e.example/\u0001)").join("");
    expect([...out].some((ch) => ch.charCodeAt(0) < 32 && ch !== "\n")).toBe(false);
  });
});

describe("chatMarkdownLines: render-time rules", () => {
  it("shows a link's address as the URL parser reads it (punycode), and only the label for an unsafe or multi-recipient link", () => {
    expect(lines("[x](https://b\u00fccher.example/p)")).toEqual([
      "x (https://xn--bcher-kva.example/p)",
    ]);
    expect(lines("[x](mailto:a@b\u00fccher.example)")).toEqual([
      "x (mailto:a@xn--bcher-kva.example)",
    ]);
    expect(lines("[https://e.example/a](https://e.example/a)")).toEqual(["https://e.example/a"]);
    expect(
      lines(
        "[a](mailto:a@x.example,b@y.example) [b](mailto:a%2Cb@y.example) [c](mailto:a@x.example?cc=b@y.example)"
      )
    ).toEqual(["a b c"]);
  });
  it("strips escape, C1, bidi and tag characters from forged nodes, and draws unknown or malformed nodes as nothing", () => {
    const forged = {
      truncated: false,
      blocks: [
        {
          type: "heading",
          level: 99,
          inlines: [{ type: "text", text: "h\u001b]52;c;x\u0007\u202e!" }],
        },
        {
          type: "paragraph",
          inlines: [
            { type: "link", href: "javascript:x", children: [{ type: "text", text: "l\u009b" }] },
            { type: "bogus" },
            { type: "text", text: 5 },
          ],
        },
        { type: "code", text: "a\u001b[2J\nb" },
        { type: "nope" },
        null,
      ],
    } as unknown as MdDoc;
    expect(chatMarkdownLines(forged)).toEqual(["###### h]52;c;x!", "", "l", "", "| a[2J", "| b"]);
  });
  it("ends a deeply nested forged document without recursing without bound", () => {
    let node: unknown = { type: "paragraph", inlines: [{ type: "text", text: "x" }] };
    for (let k = 0; k < 20000; k++) node = { type: "quote", blocks: [node] };
    expect(() => chatMarkdownLines({ truncated: false, blocks: [node] } as MdDoc)).not.toThrow();
  });

  it("ends a forged tree with shared children (a DAG) quickly, inside a fixed output budget", () => {
    // 8 references per level, 16 levels: 8^16 walks if every path were followed.
    let inl: unknown = { type: "text", text: "shared-leaf " };
    let blk: unknown = { type: "paragraph", inlines: [inl] };
    for (let k = 0; k < 16; k++) {
      inl = { type: "em", children: Array(8).fill(inl) };
      blk = { type: "list", ordered: false, items: Array(8).fill([blk]) };
    }
    const a = chatMarkdownLines({
      truncated: false,
      blocks: [{ type: "paragraph", inlines: [inl] }],
    } as unknown as MdDoc);
    const b = chatMarkdownLines({ truncated: false, blocks: [blk] } as unknown as MdDoc);
    for (const out of [a, b]) {
      expect(out.join("").length).toBeLessThanOrEqual(MD_MAX_CHARS + 400);
      expect(out.length).toBeLessThanOrEqual(202);
      expect(out.at(-1)).toBe("…");
    }
  });
  it("stops at a caller's character budget and says so", () => {
    const doc = parseChatMarkdown("word ".repeat(300));
    const out = chatMarkdownLines(doc, { maxChars: 100 });
    expect(out.join("").length).toBeLessThanOrEqual(101);
    expect(out.at(-1)).toBe("…");
  });
  it("cleans U+2028/U+2029 to spaces, drops a stray U+FE0F, and strips C1, bidi and ZWSP, in every leaf", () => {
    const bad = "a\u2028b\u2029c\ufe0fd\u009be\u202ef\u2066g\u200bh";
    const doc = {
      truncated: false,
      blocks: [
        {
          type: "paragraph",
          inlines: [
            { type: "text", text: bad },
            { type: "code", text: bad },
          ],
        },
        { type: "code", text: bad },
        { type: "link-holder" },
        {
          type: "paragraph",
          inlines: [{ type: "link", href: "mailto:a\u2028b@x.example", children: [] }],
        },
      ],
    } as unknown as MdDoc;
    const out = chatMarkdownLines(doc).join("\n");
    expect(out).toContain("a b cdefgh");
    for (const ch of ["\u2028", "\u2029", "\ufe0f", "\u009b", "\u202e", "\u2066", "\u200b"])
      expect(out.includes(ch), JSON.stringify(ch)).toBe(false);
  });
  it("keeps the address visible next to a very long label", () => {
    const out = chatMarkdownLines(
      parseChatMarkdown(`[${"https://good.example/".repeat(200)}](https://evil.example/x)`)
    );
    expect(out[0]?.length).toBeLessThanOrEqual(2000);
    expect(out[0]).toMatch(/\(https:\/\/evil\.example\/x\)$/);
  });
});
