import { hydrationPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { handleOfPath } from "@loom-ui/hydration/client";
import {
  type Blueprint,
  MetricCard,
  RendererRegistry,
  type Widget,
  blueprint$,
  cell,
  customWidget$,
  grid,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DomWidgetRenderer, renderBlueprintDom } from "./index";

// U17: `onVisible` is driven by ONE IntersectionObserver per rendered tree (a fake here — no layout in
// happy-dom). The P2 contract it serves: a handle is fetched when `markVisible(handle)` is called.

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly init?: IntersectionObserverInit
  ) {
    FakeIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
    this.disconnected = true;
  }
  /** Deliver one intersection change for `el`. */
  fire(el: Element, isIntersecting: boolean): void {
    this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}

const original = globalThis.IntersectionObserver;
beforeEach(() => {
  FakeIO.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
});
afterEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
});

const registry = new RendererRegistry<DomWidgetRenderer>().register("MetricCard", (host) => {
  const el = document.createElement("span");
  host.appendChild(el);
  return { update: () => {}, patch: () => {}, dispose: () => el.remove() };
});
// No `patch`: a changed widget REMOUNTS, so its host is observed afresh (a real observer then delivers
// the element's current state on `observe`, which a test plays with `fire`).
const remounting = new RendererRegistry<DomWidgetRenderer>().register("MetricCard", (host) => {
  const el = document.createElement("span");
  host.appendChild(el);
  return { update: () => {}, dispose: () => el.remove() };
});
const binding = (handle: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
});
const make = (widgets: Widget[]): Blueprint =>
  blueprint$({
    id: "e@v",
    title: "T",
    layout: grid({ columns: 12, children: widgets.map((w) => cell(4, w)) }),
    projections: [HYDRATION_PROJECTION_ID],
  });
const bound = (id: string, handle: string): Widget =>
  MetricCard({ id, title: id, binding: binding(handle) });

function rig(widgets: Widget[], onVisible?: (w: Widget) => void, reg = registry) {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  const host = document.createElement("div");
  const handle = renderBlueprintDom(host, make(widgets), {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: reg,
    ...(onVisible && { onVisible }),
  });
  const hostOf = (id: string) => host.querySelector(`[data-widget-id='${id}']`) as HTMLElement;
  return { runtime, store, host, handle, hostOf };
}

describe("onVisible (U17)", () => {
  it("observes nothing without onVisible: no observer is even created", () => {
    rig([bound("a", "ha")]);
    expect(FakeIO.instances).toHaveLength(0);
  });

  it("uses one shared observer and watches only BOUND widgets", () => {
    const unbound = customWidget$({ kind: "MetricCard", id: "u", title: "u" });
    const r = rig([bound("a", "ha"), bound("b", "hb"), unbound], () => {});
    expect(FakeIO.instances).toHaveLength(1);
    const io = FakeIO.instances[0] as FakeIO;
    expect([...io.observed]).toEqual([r.hostOf("a"), r.hostOf("b")]);
    expect(io.init?.rootMargin).toBe("100px");
  });

  it("reports a widget when it enters view, once while it stays, and again on re-entry", () => {
    const seen: string[] = [];
    const r = rig([bound("a", "ha"), bound("b", "hb")], (w) => seen.push(w.id));
    const io = FakeIO.instances[0] as FakeIO;
    expect(seen).toEqual([]); // nothing is visible until the observer says so
    io.fire(r.hostOf("a"), false);
    expect(seen).toEqual([]);
    io.fire(r.hostOf("a"), true);
    io.fire(r.hostOf("a"), true);
    expect(seen).toEqual(["a"]);
    io.fire(r.hostOf("b"), true);
    io.fire(r.hostOf("a"), false);
    io.fire(r.hostOf("a"), true);
    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("drives markVisible(handle) for exactly the handles that scrolled into view", () => {
    const marked: string[] = [];
    const r = rig([bound("a", "ha"), bound("b", "hb")], (w) => {
      const h = w.binding && handleOfPath(w.binding.path);
      if (h !== undefined) marked.push(h);
    });
    (FakeIO.instances[0] as FakeIO).fire(r.hostOf("b"), true);
    expect(marked).toEqual(["hb"]);
  });

  it("unobserves a widget the next blueprint drops, and disconnects on dispose", () => {
    const seen: string[] = [];
    const r = rig([bound("a", "ha"), bound("b", "hb")], (w) => seen.push(w.id));
    const io = FakeIO.instances[0] as FakeIO;
    const bHost = r.hostOf("b");
    r.handle.update(make([bound("a", "ha")]));
    expect(io.observed.has(bHost)).toBe(false);
    expect(io.observed.size).toBe(1);
    io.fire(bHost, true); // a late delivery for a dead widget is ignored
    expect(seen).toEqual([]);
    r.handle.dispose();
    expect(io.disconnected).toBe(true);
    expect(io.observed.size).toBe(0);
  });

  it("a rebound widget that is on screen is reported again under its NEW binding", () => {
    const paths: string[] = [];
    const r = rig([bound("a", "h1")], (w) => paths.push(w.binding?.path ?? ""));
    const io = FakeIO.instances[0] as FakeIO;
    io.fire(r.hostOf("a"), true);
    r.handle.update(make([bound("a", "h2")]));
    expect(paths).toEqual([hydrationPath("h1"), hydrationPath("h2")]);
    // Off screen, a rebind reports nothing: its next entry will.
    io.fire(r.hostOf("a"), false);
    r.handle.update(make([bound("a", "h3")]));
    expect(paths).toHaveLength(2);
    io.fire(r.hostOf("a"), true);
    expect(paths[2]).toBe(hydrationPath("h3"));
  });

  it("a remounted widget is observed afresh: the old observation is stopped, never doubled", () => {
    const seen: string[] = [];
    const r = rig([bound("a", "h1")], (w) => seen.push(w.id), remounting);
    const io = FakeIO.instances[0] as FakeIO;
    io.fire(r.hostOf("a"), true);
    r.handle.update(make([bound("a", "h2")]));
    expect(io.observed.size).toBe(1);
    io.fire(r.hostOf("a"), true); // the observer's initial delivery for the re-observed host
    expect(seen).toEqual(["a", "a"]);
  });

  it("a throwing onVisible never breaks the observer or the render", () => {
    const r = rig([bound("a", "ha"), bound("b", "hb")], () => {
      throw new Error("host bug");
    });
    const io = FakeIO.instances[0] as FakeIO;
    expect(() => io.fire(r.hostOf("a"), true)).not.toThrow();
    expect(() => io.fire(r.hostOf("b"), true)).not.toThrow();
  });

  it("without IntersectionObserver it fails OPEN: every bound widget is reported at mount", () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const seen: string[] = [];
    rig([bound("a", "ha"), customWidget$({ kind: "MetricCard", id: "u", title: "u" })], (w) =>
      seen.push(w.id)
    );
    expect(seen).toEqual(["a"]);
  });
});
