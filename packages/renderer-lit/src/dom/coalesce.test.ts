import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, RendererRegistry, blueprint$, cell, grid } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { LitElement, html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { defineElement } from "../define";
import {
  type DomWidgetRenderer,
  type FrameScheduler,
  animationFrameScheduler,
  coalesceUpdates,
  elementRenderer,
  renderBlueprintDom,
} from "./index";

// U17: a burst inside one frame is ONE render of the newest state. The scheduler is injected, so
// "a frame" is a function call here — no timers, no sleeps.

/** A scheduler the test fires by hand. */
function manual(): {
  schedule: FrameScheduler;
  frame: () => void;
  scheduled: () => number;
  cancelled: () => number;
} {
  let queued: (() => void) | undefined;
  let scheduledCount = 0;
  let cancelledCount = 0;
  return {
    schedule: (run) => {
      queued = run;
      scheduledCount++;
      return () => {
        if (queued === run) queued = undefined;
        cancelledCount++;
      };
    },
    frame: () => {
      const q = queued;
      queued = undefined;
      q?.();
    },
    scheduled: () => scheduledCount,
    cancelled: () => cancelledCount,
  };
}

const bp = (title: string) =>
  blueprint$({
    id: `e@${title}`,
    title,
    layout: grid({
      columns: 12,
      children: [
        cell(
          4,
          MetricCard({
            id: "m",
            title,
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.m" },
          })
        ),
      ],
    }),
    projections: [HYDRATION_PROJECTION_ID],
  });
const rig = () => {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "e" });
  const registry = new RendererRegistry<DomWidgetRenderer>().register("MetricCard", (host) => {
    const el = document.createElement("span");
    host.appendChild(el);
    return {
      update: () => {},
      patch: (w) => {
        el.textContent = w.title ?? null;
      },
      dispose: () => el.remove(),
    };
  });
  const host = document.createElement("div");
  const handle = renderBlueprintDom(host, bp("v0"), {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry,
  });
  const update = vi.spyOn(handle, "update");
  return { handle, update, host };
};

describe("coalesceUpdates", () => {
  it("N updates inside a frame cost ONE handle.update, of the newest Blueprint", async () => {
    const { handle, update } = rig();
    const f = manual();
    const c = coalesceUpdates(handle, { schedule: f.schedule });
    const reports = [c.update(bp("v1")), c.update(bp("v2")), c.update(bp("v3"))];
    expect(update).not.toHaveBeenCalled();
    expect(c.pending).toBe(true);
    expect(f.scheduled()).toBe(1); // one frame requested, not three
    f.frame();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0].title).toBe("v3");
    const settled = await Promise.all(reports);
    expect(settled[0]).toBe(settled[2]); // every absorbed call hears the pass that landed
    expect(settled[0]?.findings).toEqual([]);
    expect(c.pending).toBe(false);
  });

  it("the next burst schedules a fresh frame", () => {
    const { handle, update } = rig();
    const f = manual();
    const c = coalesceUpdates(handle, { schedule: f.schedule });
    void c.update(bp("v1"));
    f.frame();
    void c.update(bp("v2"));
    void c.update(bp("v3"));
    f.frame();
    expect(update.mock.calls.map((a) => a[0].title)).toEqual(["v1", "v3"]);
    expect(f.scheduled()).toBe(2);
  });

  it("works with a scheduler that runs synchronously (no stuck state)", () => {
    const { handle, update } = rig();
    const c = coalesceUpdates(handle, {
      schedule: (run) => {
        run();
        return () => {};
      },
    });
    void c.update(bp("v1"));
    void c.update(bp("v2"));
    expect(update.mock.calls.map((a) => a[0].title)).toEqual(["v1", "v2"]);
  });

  it("flush lands the pending Blueprint now; dispose drops it and resolves callers undefined", async () => {
    const { handle, update } = rig();
    const f = manual();
    const c = coalesceUpdates(handle, { schedule: f.schedule });
    expect(c.flush()).toBeUndefined();
    void c.update(bp("v1"));
    expect(c.flush()?.findings).toEqual([]);
    f.frame(); // the cancelled frame is a no-op
    expect(update).toHaveBeenCalledTimes(1);
    const dropped = c.update(bp("v2"));
    c.dispose();
    expect(await dropped).toBeUndefined();
    expect(f.cancelled()).toBeGreaterThan(0);
    f.frame();
    expect(update).toHaveBeenCalledTimes(1);
    expect(await c.update(bp("v3"))).toBeUndefined(); // after dispose nothing is queued
  });

  it("the default scheduler lands on a real animation frame or its deadline", async () => {
    const { handle, update } = rig();
    const c = coalesceUpdates(handle, { schedule: animationFrameScheduler });
    await c.update(bp("v1")); // resolves when the frame (or the fallback deadline) fires
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("elementRenderer({ coalesce })", () => {
  let renders = 0;
  class LuCountProbe extends LitElement {
    static properties = { widget: {}, value: {}, status: {}, onAction: {} };
    value: unknown;
    widget: unknown;
    status: unknown;
    onAction: unknown;
    render() {
      renders++;
      return html`${String(this.value)}`;
    }
  }
  defineElement("lu-count-probe", LuCountProbe);
  const props = {
    widget: { id: "w", kind: "X", title: "t", props: {} },
    value: 0,
    status: undefined,
    onAction: undefined,
  } as never;

  it("a burst of value updates reaches the element once, newest wins; without coalesce every one lands", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const f = manual();
    const h = elementRenderer("lu-count-probe", { coalesce: f.schedule })(host, props);
    const el = host.querySelector("lu-count-probe") as LuCountProbe;
    await el.updateComplete;
    const before = renders;
    for (let i = 1; i <= 50; i++) h.update(i, undefined);
    expect(el.value).toBe(0); // nothing applied yet
    f.frame();
    await el.updateComplete;
    expect(el.value).toBe(50);
    expect(renders - before).toBe(1);
    expect(f.scheduled()).toBe(1);
    // Disposal cancels what is pending and applies nothing.
    h.update(51, undefined);
    h.dispose();
    f.frame();
    expect(el.value).toBe(50);

    const plain = elementRenderer("lu-count-probe")(host, props);
    const el2 = host.querySelector("lu-count-probe") as LuCountProbe;
    plain.update(7, undefined);
    expect(el2.value).toBe(7); // default: synchronous, as before
  });
});
