import { describe, expect, it } from "vitest";
import { parseInlines } from "./chatMdInline";
import { MD_MAX_NODES, type MdInline, type MdState, mdPlainText } from "./chatMdTypes";

// Deterministic work counter (no wall-clock): `meter.steps` is bumped once per scanned character / delimiter step.
const run = (t: string, o: { markers?: boolean; streaming?: boolean } = {}) => {
  const meter = { steps: 0 };
  const st: MdState = {
    nodes: 0,
    truncated: false,
    markers: o.markers === true,
    streaming: o.streaming === true,
    meter,
  };
  const out = parseInlines(t, st);
  return { out, steps: meter.steps, st };
};
const depth = (ns: readonly MdInline[]): number =>
  Math.max(0, ...ns.map((n) => ("children" in n ? 1 + depth(n.children) : 0)));
const hasMarker = (ns: readonly MdInline[]): boolean =>
  ns.some((n) => n.type === "marker" || ("children" in n && hasMarker(n.children)));

describe("escaped backticks (C1)", () => {
  it.each(["\\``", "a \\`` b", "a\\`b", "\\```x``` y", "\\`` `` x"])(
    "does not throw on %j",
    (t) => {
      expect(() => run(t)).not.toThrow();
      expect(() => run(t, { streaming: true, markers: true })).not.toThrow();
    }
  );
  it("keeps the characters", () => {
    expect(mdPlainText(run("a \\`` b").out)).toBe("a `` b");
    expect(mdPlainText(run("a\\`b").out)).toBe("a`b");
  });
});

describe("long delimiter runs (C2)", () => {
  it("do not recurse without bound", () => {
    for (const n of [20000, 30000]) {
      const t = `${"*".repeat(n)}a${"*".repeat(n)}`;
      expect(() => run(t)).not.toThrow();
      expect(depth(run(t).out)).toBeLessThanOrEqual(4);
      const w = `${"[".repeat(n)}${"*".repeat(n)}a${"*".repeat(n)}](x)`;
      expect(() => run(w)).not.toThrow();
    }
  });
});

describe("markers never sit inside a link label (I4)", () => {
  it("at any depth", () => {
    const out = run("[**x [[a1]]**](https://x.example)", { markers: true }).out;
    expect(out[0]).toMatchObject({ type: "link" });
    expect(hasMarker(out)).toBe(false);
  });
});

describe("a failed ] closes its [ (M1)", () => {
  it("does not stretch a later label over it", () => {
    const out = run("[x] y](https://z.example)").out;
    expect(out.map((n) => n.type)).not.toContain("link");
  });
});

describe("work is linear in the input (steps, not seconds)", () => {
  const cases: Record<string, (k: number) => string> = {
    "open link": (k) => "[a](".repeat(k),
    "open link angle": (k) => "[a](<".repeat(k),
    "open link title": (k) => '[a](x "'.repeat(k),
    "open link quote": (k) => "[a](x '".repeat(k),
    brackets: (k) => "[".repeat(k * 4),
    "bracket code": (k) => `[${"`a`]".repeat(k)}`,
    stars: (k) => "*a ".repeat(k),
    "star pairs": (k) => "*a*".repeat(k),
    "long runs": (k) => `${"*".repeat(k)}a${"*".repeat(k)}`,
    ticks: (k) => "`a ".repeat(k),
    markers: (k) => "[[".repeat(k),
    "closing brackets": (k) => "[a]".repeat(k),
    breaks: (k) => "a  \n".repeat(k),
  };
  for (const [name, mk] of Object.entries(cases))
    for (const streaming of [false, true])
      it(`${name} (streaming ${streaming})`, () => {
        const small = mk(8000);
        const big = mk(16000);
        const a = run(small, { markers: true, streaming });
        const b = run(big, { markers: true, streaming });
        expect(b.steps, name).toBeLessThanOrEqual(1000 * big.length);
        // doubling the input at most (about) doubles the work: a quadratic scan quadruples it
        expect(b.steps, name).toBeLessThanOrEqual(2.5 * Math.max(a.steps, 1));
        expect(b.st.nodes).toBeLessThanOrEqual(MD_MAX_NODES);
      });
});
