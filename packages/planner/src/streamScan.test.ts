import { describe, expect, it } from "vitest";
import { NodeScanner } from "./streamScan";

const doc = JSON.stringify({
  summary: 'has } and { and "quotes" [x]',
  nodes: [
    { id: "a", type: "Metric", label: "A {x}", props: { s: '}\\"' } },
    { id: "b", type: "Insight", label: "B", props: { nested: { deep: [1, { z: 2 }] } } },
  ],
});

describe("NodeScanner — incremental extraction of completed nodes", () => {
  it("yields each node as soon as its closing brace arrives, whatever the chunking", () => {
    for (const size of [1, 2, 3, 7, 64, doc.length]) {
      const s = new NodeScanner();
      const seen: string[] = [];
      for (let i = 0; i < doc.length; i += size)
        for (const n of s.feed(doc.slice(i, i + size))) seen.push((n as { id: string }).id);
      expect(seen).toEqual(["a", "b"]);
    }
  });

  it("does not yield a node before it is closed", () => {
    const s = new NodeScanner();
    const cut = doc.indexOf('"id":"b"') + 5;
    expect(s.feed(doc.slice(0, cut)).map((n) => (n as { id: string }).id)).toEqual(["a"]);
  });

  it("tolerates a code fence and prose before the object, and ignores what follows it", () => {
    const s = new NodeScanner();
    const out = s.feed(`\`\`\`json\n${doc}\n\`\`\`\nthanks`);
    expect(out).toHaveLength(2);
  });

  it("ignores `nodes`-looking content in a string or another key", () => {
    const s = new NodeScanner();
    const d = JSON.stringify({
      summary: '"nodes":[{"id":"x"}]',
      other: [{ id: "y" }],
      nodes: [{ id: "z" }],
    });
    expect(s.feed(d)).toEqual([{ id: "z" }]);
  });

  it("skips a node that is not valid JSON instead of throwing", () => {
    const s = new NodeScanner();
    expect(s.feed('{"nodes":[{"id":}, {"id":"ok"}]}')).toEqual([{ id: "ok" }]);
  });

  it("is bounded: past the node cap, the node-size cap or the char cap it stops yielding, never throws", () => {
    const many = `{"nodes":[${Array.from({ length: 50 }, (_, i) => `{"id":"n${i}"}`).join(",")}]}`;
    expect(new NodeScanner({ maxNodes: 24 }).feed(many)).toHaveLength(24);
    const big = `{"nodes":[{"id":"${"x".repeat(100)}"},{"id":"ok"}]}`;
    const s = new NodeScanner({ maxNodeChars: 50 });
    expect(s.feed(big)).toEqual([]);
    expect(s.stopped).toBe(true);
    const c = new NodeScanner({ maxChars: 10 });
    expect(c.feed(many)).toEqual([]);
    expect(c.stopped).toBe(true);
  });

  it("is linear: scanning 20k chars in 1-char chunks does not re-scan", () => {
    const s = new NodeScanner({ maxChars: 1e6 });
    const big = `{"nodes":[${Array.from({ length: 24 }, (_, i) => `{"id":"n${i}","p":"${"y".repeat(800)}"}`).join(",")}]}`;
    const t = Date.now();
    let n = 0;
    for (const ch of big) n += s.feed(ch).length;
    expect(n).toBe(24);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
