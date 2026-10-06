import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationStore } from "./projection";

const mk = () => new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });

describe("HydrationStore.append — token streams into a handle", () => {
  it("accumulates chunks into the handle's string value; pending while open, ready on done", () => {
    const s = mk();
    expect(s.append("t", { seq: 0, text: "Hel" })).toEqual({ ok: true, applied: true });
    expect(s.value("t")).toBe("Hel");
    expect(s.status("t")?.state).toBe("pending");
    s.append("t", { seq: 1, text: "lo", done: true });
    expect(s.value("t")).toBe("Hello");
    expect(s.status("t")?.state).toBe("ready");
  });

  it("is idempotent: a redelivered chunk emits nothing (no re-render, no double token)", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "a" });
    const seen: unknown[] = [];
    s.subscribe("t", (x) => seen.push(x.value));
    expect(s.append("t", { seq: 0, text: "a" })).toEqual({ ok: true, applied: false });
    expect(seen).toEqual([]);
    expect(s.value("t")).toBe("a");
  });

  it("refuses a gap, a closed stream and a bad chunk with a finding, leaving the value untouched", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "a", done: true });
    for (const [chunk, code] of [
      [{ seq: 1, text: "b" }, "stream-closed"],
      [{ seq: "x" }, "stream-chunk-invalid"],
    ] as const) {
      const r = s.append("t", chunk);
      expect(!r.ok && r.finding.code).toBe(code);
    }
    expect(s.value("t")).toBe("a");
    const g = mk();
    g.append("u", { seq: 0, text: "a" });
    const r = g.append("u", { seq: 5, text: "z" });
    expect(!r.ok && r.finding.code).toBe("stream-gap");
    expect(g.value("u")).toBe("a");
  });

  it("ORDERING vs a replace: setValue / remove / empty end the stream; a stale producer's tail is refused, not spliced in", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "old " });
    // the controller re-loads the handle (supersede): a whole-value replace wins
    s.setValue("t", "fresh", { state: "ready" });
    const tail = s.append("t", { seq: 1, text: "tail" });
    expect(!tail.ok && tail.finding.code).toBe("stream-gap");
    expect(s.value("t")).toBe("fresh");
    // a NEW stream starts at 0 and replaces the value wholesale
    s.append("t", { seq: 0, text: "next" });
    expect(s.value("t")).toBe("next");
    s.remove("t");
    expect(s.append("t", { seq: 1, text: "x" }).ok).toBe(false);
    s.append("e", { seq: 0, text: "x" });
    s.setStatus("e", { state: "empty" });
    expect(s.append("e", { seq: 1, text: "y" }).ok).toBe(false);
  });

  it("refuses a reserved handle like every other writer", () => {
    expect(() => mk().append("__proto__", { seq: 0, text: "x" })).toThrow(/reserved/);
  });

  it("streams are per store: two viewers of one experience never share a token", () => {
    const rt = new InMemoryProjectionRuntime();
    const a = new HydrationStore(rt, { experienceId: "e", principalId: "a" });
    const b = new HydrationStore(rt, { experienceId: "e", principalId: "b" });
    a.append("t", { seq: 0, text: "secret" });
    expect(b.value("t")).toBeUndefined();
  });
});
