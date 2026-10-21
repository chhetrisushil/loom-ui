import { describe, expect, it } from "vitest";
import { parseChatMarkdownMetered } from "./chatMdMeter.test-support";
import { MD_MAX_NODES } from "./chatMdTypes";

const run = (t: string, o: { markers?: boolean; streaming?: boolean } = {}) => {
  const meter = { steps: 0 };
  return { doc: parseChatMarkdownMetered(t, o, meter), steps: meter.steps };
};

describe("tables are charged to the node budget (I3)", () => {
  it("empty padded cells count, so a flood of rows is cut and says so", () => {
    const header = `|a|b|c|d|e|f|g|h|i|j|k|l|\n|-|-|-|-|-|-|-|-|-|-|-|-|\n${"|\n".repeat(99)}`;
    const t = header.repeat(30);
    const { doc } = run(t);
    expect(doc.truncated).toBe(true);
    let cells = 0;
    for (const b of doc.blocks)
      if (b.type === "table") cells += b.head.length + b.rows.length * b.head.length;
    expect(cells).toBeLessThanOrEqual(MD_MAX_NODES);
  });
});

describe("work is linear in the input (steps, not seconds)", () => {
  const cases: Record<string, (k: number) => string> = {
    "blank lines in an item": (k) => `- a\n${" \n".repeat(k)}  b`,
    "open link": (k) => "[a](".repeat(k),
    "quote chain": (k) => "> ".repeat(k),
    "list chain": (k) => "- ".repeat(k),
    "item lines": (k) => "- a\n".repeat(k),
    "numbered nesting": (k) => "1. a\n  ".repeat(k),
    "empty items": (k) => "-\n".repeat(k),
    fences: (k) => "```\n".repeat(k),
    "table rows": (k) => `|a|\n|-|\n${"|x|\n".repeat(k)}`,
    paragraphs: (k) => "a\n".repeat(k),
  };
  for (const [name, mk] of Object.entries(cases))
    for (const streaming of [false, true])
      it(`${name} (streaming ${streaming})`, () => {
        const a = run(mk(4000), { markers: true, streaming });
        const b = run(mk(8000), { markers: true, streaming });
        expect(b.steps, name).toBeLessThanOrEqual(1000 * mk(8000).length);
        expect(b.steps, name).toBeLessThanOrEqual(2.5 * Math.max(a.steps, 1));
      });
});
