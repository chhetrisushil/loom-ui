import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { OpStream } from "./opStream";
import { replay } from "./operations";

const base = genesis({
  experienceId: "s",
  intent: { objective: "x", source: "user" },
  meta: { author: "t", createdAt: "2026-01-01T00:00:00Z", sourceKind: "test" },
});
const insert = (id: string, order: string) =>
  ({
    type: "insertNode",
    parentId: "root",
    node: { id, order, kind: "semantic", type: "Metric", typeVersion: "1.0.0", span: 4, props: {} },
  }) as never;

describe("OpStream — folding partial op lists into a working Experience", () => {
  it("each update REPLACES the pending ops: a later partial supersedes the earlier", () => {
    const s = new OpStream(base);
    const a = s.update([insert("n1", "a0")]);
    expect(a.ok).toBe(true);
    const b = s.update([insert("n1", "a0"), insert("n2", "a1")]);
    expect(b.ok).toBe(true);
    expect(s.partials).toBe(2);
    const c = s.update([insert("n9", "a0")]);
    expect(c.ok).toBe(true);
    const kids = (s.working.root as { children: { id: string }[] }).children.map((n) => n.id);
    expect(kids).toEqual(["n9"]);
  });

  it("a partial that does not apply is reported and leaves the last good working copy", () => {
    const s = new OpStream(base);
    s.update([insert("n1", "a0")]);
    const bad = s.update([insert("n1", "a0"), insert("n1", "a1")]);
    expect(bad.ok).toBe(false);
    expect((s.working.root as { children: unknown[] }).children).toHaveLength(1);
  });

  it("never seals: the working copy is unsealed, and finish() is exactly replay(base, finalOps)", () => {
    const s = new OpStream(base);
    s.update([insert("n1", "a0")]);
    expect(s.working.versionHash).toBe("");
    const final = [insert("n1", "a0"), insert("n2", "a1")];
    const done = s.finish(final);
    const direct = replay(base, final);
    expect(done).toEqual(direct);
    // the partials are gone: finish does not depend on them
    expect(new OpStream(base).finish(final)).toEqual(direct);
  });

  it("bounds the number of partial applications (a flooding producer cannot pin the CPU)", () => {
    const s = new OpStream(base, { maxPartials: 2 });
    s.update([insert("n1", "a0")]);
    s.update([insert("n1", "a0")]);
    const third = s.update([insert("n1", "a0")]);
    expect(!third.ok && third.finding.code).toBe("stream-partials-exceeded");
  });
});
