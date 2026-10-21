import { describe, expect, it } from "vitest";
import { type MdInline, parseChatMarkdown, resolveMdMarkers } from "./chatMarkdown";

const txt = (text: string): MdInline => ({ type: "text", text });
const known = new Set(["a1", "b2"]);
const res = (t: string, hideAll = false, streaming = false) =>
  resolveMdMarkers(parseChatMarkdown(t, { markers: true, streaming }), known, { hideAll });
const first = (d: ReturnType<typeof res>): readonly MdInline[] => {
  const b = d.blocks[0];
  return b?.type === "paragraph" ? b.inlines : [];
};

describe("resolveMdMarkers", () => {
  it("numbers a listed marker by first appearance of its id", () => {
    expect(first(res("x [[b2]] y [[a1]] z [[b2]]."))).toEqual([
      txt("x "),
      { type: "ref", id: "b2", n: 1 },
      txt(" y "),
      { type: "ref", id: "a1", n: 2 },
      txt(" z "),
      { type: "ref", id: "b2", n: 1 },
      txt("."),
    ]);
  });
  it("removes a marker that is not listed, with the one space before it", () => {
    expect(first(res("Net 30 [[zzz]]."))).toEqual([txt("Net 30.")]);
    expect(first(res("[[zzz]]x"))).toEqual([txt("x")]);
  });
  it("numbers across blocks and into emphasis, lists and table cells, in reading order", () => {
    const d = res("**s [[b2]]**\n\n- i [[a1]]\n\n|h|\n|-|\n|c [[b2]]|");
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as { type?: string; id?: string; n?: number };
        if (o.type === "ref") refs.push(`${o.id}:${o.n}`);
        Object.values(v).forEach(walk);
      }
    };
    walk(d.blocks);
    expect(refs).toEqual(["b2:1", "a1:2", "b2:1"]);
  });
  it("hides every marker while the reply streams, with a half-written one", () => {
    expect(first(res("Due [[a1]] in 30", true))).toEqual([txt("Due in 30")]);
    expect(first(res("Due [[a1", true, true))).toEqual([txt("Due")]);
  });
  it("never leaves a marker node for a renderer to draw", () => {
    expect(JSON.stringify(res("a [[a1]] [[zzz]]"))).not.toContain('"marker"');
    expect(JSON.stringify(res("a [[a1]]", true))).not.toContain('"ref"');
  });
});
