import { type SignalBatch, SignalCollector } from "@loom-ui/core/signals";
import { describe, expect, it } from "vitest";
import { observeSignals } from "./signals";

type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
class FakeIO {
  static last: FakeIO | undefined;
  observed = new Set<Element>();
  constructor(private readonly cb: (e: Entry[]) => void) {
    FakeIO.last = this;
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  fire(target: Element, ratio: number) {
    this.cb([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
}

function page(ids: string[], blueprintId = "exp@sha256:v1") {
  const root = document.createElement("div");
  root.dataset.blueprintId = blueprintId;
  document.body.append(root);
  const els = ids.map((id) => {
    const el = document.createElement("div");
    el.dataset.widgetId = id;
    el.textContent = `SECRET TEXT of ${id}`;
    root.append(el);
    return el;
  });
  return { root, els };
}

function rig(ids: string[], extra: Partial<Parameters<typeof observeSignals>[2]> = {}) {
  const { root, els } = page(ids);
  const sent: SignalBatch[] = [];
  let n = 0;
  const collector = new SignalCollector({
    sink: (b) => void sent.push(b),
    newBatchId: () => `b${++n}`,
  });
  let t = 0;
  const obs = observeSignals({ element: root }, collector, {
    IntersectionObserver: FakeIO as never,
    now: () => t,
    ...extra,
  });
  return {
    root,
    els,
    sent,
    collector,
    obs,
    io: FakeIO.last as FakeIO,
    at: (ms: number) => {
      t = ms;
    },
  };
}

describe("U11 observeSignals (renderer-lit/signals)", () => {
  it("exposure needs the widget at least half visible; dwell is accumulated and sent as a bucket", async () => {
    const r = rig(["kpi", "table"]);
    r.at(100);
    r.io.fire(r.els[0] as Element, 0.3); // not enough
    r.io.fire(r.els[1] as Element, 0.9);
    r.at(7_100);
    r.io.fire(r.els[1] as Element, 0); // left after 7 s
    await r.collector.flush({ final: true });
    const s = r.sent[0]?.signals ?? [];
    expect(s).toContainEqual({ kind: "exposure", node: "table" });
    expect(s).toContainEqual({ kind: "engagement", action: "dwell", bucket: 2, node: "table" });
    expect(s.some((x) => "node" in x && x.node === "kpi")).toBe(false);
    expect(r.sent[0]?.view).toEqual({ experienceId: "exp", versionHash: "sha256:v1" });
    expect(JSON.stringify(r.sent)).not.toMatch(/SECRET|7000|7100|7\.0/); // no text, no raw timing
    r.obs.dispose();
  });

  it("without an IntersectionObserver nothing is claimed as exposed", async () => {
    const { root } = page(["a"]);
    const sent: SignalBatch[] = [];
    const c = new SignalCollector({ sink: (b) => void sent.push(b) });
    const prev = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const obs = observeSignals({ element: root }, c, {});
    root.querySelector("div")?.click();
    await c.flush();
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = prev;
    // the click is an engagement; there is NO exposure signal
    expect(sent[0]?.signals).toEqual([
      { kind: "engagement", action: "click", count: 1, node: "a" },
    ]);
    obs.dispose();
  });

  it("a click anywhere inside a widget, and a <details> opening, are engagements on that widget", async () => {
    const r = rig(["card"]);
    const inner = document.createElement("button");
    const details = document.createElement("details");
    r.els[0]?.append(inner, details);
    inner.click();
    inner.click();
    details.open = true;
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.click(); // outside the root: ignored
    await r.collector.flush();
    expect(r.sent[0]?.signals).toContainEqual({
      kind: "engagement",
      action: "click",
      count: 2,
      node: "card",
    });
    expect(r.sent[0]?.signals).toContainEqual({
      kind: "engagement",
      action: "expand",
      count: 1,
      node: "card",
    });
    r.obs.dispose();
  });

  it("restricted placeholders are flagged from the declared alias list", async () => {
    const r = rig(["r_AAAAAAAAAAAAAAAA", "ok"], { placeholders: ["r_AAAAAAAAAAAAAAAA"] });
    r.io.fire(r.els[0] as Element, 1);
    r.io.fire(r.els[1] as Element, 1);
    await r.collector.flush();
    const s = r.sent[0]?.signals ?? [];
    expect(s).toContainEqual({ kind: "exposure", node: "r_AAAAAAAAAAAAAAAA", restricted: true });
    expect(s).toContainEqual({ kind: "exposure", node: "ok" });
    r.obs.dispose();
  });

  it("a new Blueprint version starts a new view: the old view's batch keeps the old version", async () => {
    const r = rig(["a"]);
    r.io.fire(r.els[0] as Element, 1);
    r.root.dataset.blueprintId = "exp@sha256:v2";
    r.obs.refresh();
    r.io.fire(r.els[0] as Element, 1); // the still-visible widget is exposed again, in the NEW version
    await r.collector.flush();
    expect(r.sent.map((b) => b.view.versionHash)).toEqual(["sha256:v1", "sha256:v2"]);
    expect(r.sent.every((b) => b.signals.some((s) => s.kind === "exposure"))).toBe(true);
    r.obs.dispose();
  });

  it("dispose stops everything", async () => {
    const r = rig(["a"]);
    r.obs.dispose();
    (r.els[0] as HTMLElement).click();
    expect(r.io.observed.size).toBe(0);
    expect((await r.collector.flush()).sent).toBe(0);
  });
});
