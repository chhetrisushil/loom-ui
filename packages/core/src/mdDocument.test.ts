import { describe, expect, it } from "vitest";
import { parseChatMarkdown } from "./chatMarkdown";
import {
  MD_DOC_MAX_NODES,
  MD_DOC_MAX_TEXT,
  parseMarkdownDocument,
  parseMarkdownDocumentWith,
} from "./mdDocument";

const slice = (text: string, i: number) => {
  const d = parseMarkdownDocument(text);
  const r = d.ranges[i];
  if (!r) throw new Error(`no range ${i}`);
  return text.slice(r.from, r.to);
};

describe("parseMarkdownDocument", () => {
  it("draws the same AST as chat for small input", () => {
    const text = "# Title\n\nSome *em* and `code`.\n\n- a\n- b\n";
    expect(parseMarkdownDocument(text).blocks).toEqual(parseChatMarkdown(text).blocks);
  });

  it("gives every top-level block its exact source range", () => {
    const text =
      "# Title\n\npara one\nstill one\n\n```js\nx()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n";
    const d = parseMarkdownDocument(text);
    expect(d.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "code", "table", "quote"]);
    expect(d.ranges).toHaveLength(d.blocks.length);
    expect(slice(text, 0)).toBe("# Title");
    expect(slice(text, 1)).toBe("para one\nstill one");
    expect(slice(text, 2)).toBe("```js\nx()\n```");
    expect(slice(text, 3)).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(slice(text, 4)).toBe("> quote");
  });

  it("keeps offsets exact across CRLF, tabs and unsafe characters", () => {
    const text = "a‮b\r\n\r\n\tcode-ish para\r\n";
    const d = parseMarkdownDocument(text);
    expect(d.ranges[0]).toEqual({ from: 0, to: 3 });
    expect(text.slice(d.ranges[1]?.from, d.ranges[1]?.to)).toBe("\tcode-ish para");
  });

  it("does not fold blank runs (unlike chat)", () => {
    const text = "one\n\n\n\n\ntwo";
    const d = parseMarkdownDocument(text);
    expect(d.ranges.map((r) => text.slice(r.from, r.to))).toEqual(["one", "two"]);
  });

  it("is not cut at the chat limits", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `para ${i}`).join("\n\n");
    const d = parseMarkdownDocument(text);
    expect(d.blocks).toHaveLength(5000);
    expect(d.truncated).toBe(false);
  });

  it("is cut at the document node budget", () => {
    const text = "x\n\n".repeat(MD_DOC_MAX_NODES);
    const d = parseMarkdownDocument(text);
    expect(d.truncated).toBe(true);
    expect(d.ranges).toHaveLength(d.blocks.length);
  });

  it("is cut at the document text bound, on a line boundary", () => {
    const text = `${"y".repeat(10)}\n\n${"z".repeat(MD_DOC_MAX_TEXT)}`;
    const d = parseMarkdownDocument(text);
    expect(d.truncated).toBe(true);
    expect(d.blocks).toHaveLength(1);
  });

  it("is total on non-strings", () => {
    expect(parseMarkdownDocument(42)).toEqual({ blocks: [], ranges: [], truncated: false });
  });

  it("leaves parseChatMarkdown's bounds alone", () => {
    const text = "x\n\n".repeat(3000);
    expect(parseChatMarkdown(text).truncated).toBe(true);
  });
});

describe("parseMarkdownDocument work is linear", () => {
  const gens: Record<string, (k: number) => string> = {
    paragraphs: (k) => "p\n\n".repeat(k),
    "quote chain": (k) => "> ".repeat(k),
    "list chain": (k) => "- ".repeat(k),
    fences: (k) => "```\n".repeat(k),
    "table rows": (k) => `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(k)}`,
    emphasis: (k) => "*a ".repeat(k),
  };
  for (const [name, mk] of Object.entries(gens)) {
    it(name, () => {
      const run = (t: string) => {
        const meter = { steps: 0 };
        parseMarkdownDocumentWith(t, meter);
        return meter.steps;
      };
      const a = run(mk(4000));
      const b = run(mk(8000));
      expect(b).toBeLessThanOrEqual(1000 * mk(8000).length);
      expect(b).toBeLessThanOrEqual(2.5 * Math.max(a, 1));
    });
  }
});
