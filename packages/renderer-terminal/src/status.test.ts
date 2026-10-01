import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, cell, customWidget$, grid, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { terminalRegistry } from "./registry";
import { kindValueCheck, renderExperience } from "./status";

/** A binding on the hydration projection, with its status channel declared. */
const bound = (handle: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: stack({
    children: [
      MetricCard({ id: "a", title: "A", binding: bound("ha"), unit: "ms" }),
      MetricCard({ id: "b", title: "B", binding: bound("hb") }),
      MetricCard({ id: "c", title: "C", binding: bound("hc") }),
      MetricCard({ id: "d", title: "D", binding: bound("hd") }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});

describe("renderExperience", () => {
  it("refuses `chrome` together with `registry` (chrome only configures the default registry)", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    expect(() =>
      renderExperience(bp, store, { chrome: "host", registry: terminalRegistry() })
    ).toThrow(/chrome.*registry/);
    // Either alone is fine.
    expect(() => renderExperience(bp, store, { registry: terminalRegistry() })).not.toThrow();
    expect(() => renderExperience(bp, store, { chrome: "host" })).not.toThrow();
  });
  it("decorates each widget with its hydration status", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue("ha", 412, { state: "ready" });
    store.setStatus("hb", { state: "pending" });
    store.setValue("hc", 7, {
      state: "stale",
      finding: { code: "output-shape-drift", severity: "error", message: "drifted" },
    });
    store.setStatus("hd", {
      state: "error",
      finding: { code: "provider-failed", severity: "error", message: "tool down" },
    });
    const out = renderExperience(bp, store);
    expect(out).toContain("A: 412 ms");
    expect(out).toContain("⋯ B");
    expect(out).toContain("~ C: 7");
    expect(out).toContain("✗ D: tool down");
  });
  it("a contract violation is visible in text too", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue("ha", "not-a-number", { state: "ready" });
    expect(renderExperience(bp, store)).toMatch(/✗ A: .*contract/);
  });
  it("a status error outranks a contract violation on the same handle's stale value, like the Lit base widget", () => {
    const errBp = blueprint$({
      id: "e2@v",
      title: "Dash2",
      layout: stack({
        children: [MetricCard({ id: "e", title: "E", binding: bound("h-e") })],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e2" });
    store.setValue("h-e", "not-a-number", {
      state: "error",
      finding: { code: "provider-failed", severity: "error", message: "tool down" },
    });
    const out = renderExperience(errBp, store);
    expect(out).toContain("✗ E: tool down");
    expect(out).not.toMatch(/contract/);
  });
  // loom runs `check` ONLY for a binding that declares a status channel, so a channel-less widget
  // never reaches the seam. The framework's own `guarded` kind renderers are what still refuse a
  // bad value there — the contract holds on both paths, from two different places.
  it("a widget with NO status channel still refuses a bad value, through the framework's own kind renderer", () => {
    const noChannelBp = blueprint$({
      id: "e3@v",
      title: "Dash3",
      layout: stack({
        children: [
          customWidget$({
            id: "t",
            kind: "TimeSeries",
            title: "Latency",
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: hydrationPath("ht") },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e3" });
    store.setValue("ht", { nope: 1 }, { state: "ready" });
    const out = renderExperience(noChannelBp, store);
    expect(out).toMatch(/✗ Latency: .*contract/);
    // No channel ⇒ no matrix glyphs from loom either.
    expect(out).not.toMatch(/[⋯~]/);
  });
});

describe("kindValueCheck", () => {
  const widget = MetricCard({ id: "m", title: "p99", binding: bound("h") });
  it("reports the framework's finding for a value that violates its kind contract", () => {
    const c = kindValueCheck(widget, "oops");
    expect(c?.code).toBe("value-contract");
    expect(c?.message).toMatch(/MetricCard/);
  });
  it("says nothing about a value that satisfies its kind contract", () => {
    expect(kindValueCheck(widget, 412)).toBeUndefined();
  });
});

describe("renderExperience — placement and section titles (Blueprint IR 2.1.0)", () => {
  const board = (placed: boolean) =>
    blueprint$({
      id: "p@v",
      title: "Board",
      projections: [HYDRATION_PROJECTION_ID],
      layout: stack({
        children: [
          grid({
            columns: 12,
            title: "Today",
            children: [
              cell(
                6,
                MetricCard({ id: "b", title: "B", binding: bound("hb") }),
                placed ? { row: 1, column: 7 } : {}
              ),
              cell(
                6,
                MetricCard({ id: "a", title: "A", binding: bound("ha") }),
                placed ? { row: 1, column: 1 } : {}
              ),
              cell(
                12,
                MetricCard({ id: "c", title: "C", binding: bound("hc") }),
                placed ? { row: 2, column: 1 } : {}
              ),
            ],
          }),
        ],
      }),
    });
  const store = () => {
    const s = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "p" });
    s.setValue("ha", 1, { state: "ready" });
    s.setValue("hb", 2, { state: "ready" });
    s.setValue("hc", 3, { state: "ready" });
    return s;
  };

  it("prints a title as an underlined heading and placed cells in reading order: row, then column", () => {
    expect(renderExperience(board(true), store())).toBe(
      "════════════════════════\n  Board\n════════════════════════\nToday\n─────\nA: 1\nB: 2\nC: 3\n"
    );
  });

  it("an unplaced grid keeps document order", () => {
    expect(renderExperience(board(false), store())).toContain("Today\n─────\nB: 2\nA: 1\nC: 3\n");
  });
});

describe("renderExperience — layout roles (Blueprint IR 2.2.0, loom ADR 0099 D5)", () => {
  // No container-renderer seam on the terminal: a role is an interaction hint, a one-shot text
  // surface has none, and every child under the title in reading order is the whole content.
  const board = (role?: string) =>
    blueprint$({
      id: "r@v",
      title: "Onboarding",
      projections: [HYDRATION_PROJECTION_ID],
      layout: stack({
        ...(role !== undefined && { role }),
        title: "Steps",
        children: ["a", "b", "c"].map((id) =>
          stack({
            title: `Step ${id}`,
            children: [MetricCard({ id, title: id.toUpperCase(), binding: bound(`h${id}`) })],
          })
        ),
      }),
    });
  const store = () => {
    const s = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "r" });
    s.setValue("ha", 1, { state: "ready" });
    s.setValue("hb", 2, { state: "ready" });
    s.setValue("hc", 3, { state: "ready" });
    return s;
  };

  it("a roled container prints byte-identically to the unroled one — every step, in order", () => {
    const plain = renderExperience(board(), store());
    expect(plain).toContain("A: 1");
    expect(plain.indexOf("A: 1")).toBeLessThan(plain.indexOf("C: 3"));
    for (const role of ["stepped", "tabbed", "Malformed"])
      expect(renderExperience(board(role), store()), role).toBe(plain);
  });
});
