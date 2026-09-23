import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import {
  MetricCard,
  RendererRegistry,
  StatusBadge,
  blueprint$,
  cell,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { type DomWidgetRenderer, renderBlueprintDom } from "./index";

const recording = (): { registry: RendererRegistry<DomWidgetRenderer>; calls: string[] } => {
  const calls: string[] = [];
  const renderer: DomWidgetRenderer = (host, props) => {
    const el = document.createElement("span");
    el.dataset.kind = props.widget.kind;
    el.textContent = `${props.widget.title}=${String(props.value)}|${props.status?.state ?? "-"}`;
    host.appendChild(el);
    calls.push(`mount:${props.widget.id}`);
    return {
      update: (value, status) => {
        el.textContent = `${props.widget.title}=${String(value)}|${status?.state ?? "-"}`;
        calls.push(`update:${props.widget.id}`);
      },
      dispose: () => calls.push(`dispose:${props.widget.id}`),
    };
  };
  return {
    registry: new RendererRegistry<DomWidgetRenderer>()
      .register("MetricCard", renderer)
      .register("StatusBadge", renderer),
    calls,
  };
};

/** A hydration binding, IR 2.0.0: the value path and the status path beside it. */
const bind = (handle: string) => ({
  projectionId: HYDRATION_PROJECTION_ID,
  path: hydrationPath(handle),
  status: { path: hydrationStatusPath(handle) },
});

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: grid({
    columns: 12,
    children: [
      cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99") })),
      stack({
        children: [StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") })],
      }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});

describe("renderBlueprintDom", () => {
  it("mounts containers and widgets, passes the status its binding declares a path for, honours a grid cell's span", () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    store.setValue("h-p99", 412, { state: "ready" });
    const { registry, calls } = recording();
    const host = document.createElement("div");
    const handle = renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    expect(host.querySelector("[data-blueprint-id='e@v']")).not.toBeNull();
    const gridEl = host.querySelector("[data-layout='grid']") as HTMLElement;
    expect(gridEl.style.gridTemplateColumns).toBe("repeat(12, 1fr)");
    const p99Host = host.querySelector("[data-widget-id='p99']") as HTMLElement;
    // The span lands on the widget's OWN host — no wrapper element between it and the grid.
    expect(p99Host.style.gridColumn).toBe("span 4");
    expect(p99Host.parentElement).toBe(gridEl);
    // …and a span-1 cell is left alone: no `grid-column` at all, not "span 1".
    const stackEl = host.querySelector("[data-layout='stack']") as HTMLElement;
    expect(stackEl.parentElement).toBe(gridEl);
    expect(stackEl.style.gridColumn).toBe("");
    expect(p99Host.textContent).toBe("p99=412|ready");
    expect(host.querySelector("[data-widget-id='phase']")?.textContent).toBe("Phase=undefined|-");
    expect(calls).toEqual(["mount:p99", "mount:phase"]);
    handle.dispose();
    expect(calls.slice(-2).sort()).toEqual(["dispose:p99", "dispose:phase"]);
  });
  it("updates only the widget whose slice changed, with its status", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const { registry, calls } = recording();
    const host = document.createElement("div");
    renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    calls.length = 0;
    store.setStatus("h-phase", { state: "pending" });
    store.setValue("h-phase", "triaging", { state: "ready" });
    await Promise.resolve();
    expect(calls).toEqual(["update:phase", "update:phase"]);
    expect(host.querySelector("[data-widget-id='phase']")?.textContent).toBe(
      "Phase=triaging|ready"
    );
    store.setStatus("h-p99", {
      state: "stale",
      finding: { code: "output-shape-drift", severity: "error", message: "m" },
    });
    await Promise.resolve();
    expect(calls.at(-1)).toBe("update:p99");
    expect(host.querySelector("[data-widget-id='p99']")?.textContent).toBe("p99=undefined|stale");
  });
  it("a kind with no renderer gets loom's placeholder text; a renderer that throws on mount yields the error placeholder and the rest still renders", () => {
    const runtime = new InMemoryProjectionRuntime();
    new HydrationStore(runtime, { experienceId: "e" });
    const throwing: DomWidgetRenderer = () => {
      throw new Error("boom");
    };
    const registry = new RendererRegistry<DomWidgetRenderer>().register("MetricCard", throwing);
    const host = document.createElement("div");
    renderBlueprintDom(host, bp, { projectionRuntime: runtime, executionId: "e", registry });
    expect(host.querySelector("[data-widget-id='phase']")?.textContent).toBe(
      "[No renderer for StatusBadge]"
    );
    expect(host.querySelector("[data-widget-id='p99']")?.textContent).toMatch(
      /\[Renderer error for MetricCard/
    );
  });
  it("a binding to values.__proto__ mounts with NO status — the status map is read by own key", () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const proto = blueprint$({
      id: "p",
      title: "P",
      layout: stack({
        children: [
          MetricCard({
            id: "proto",
            title: "Proto",
            binding: {
              projectionId: HYDRATION_PROJECTION_ID,
              path: "values.__proto__",
              status: { path: "status.__proto__" },
            },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const { registry } = recording();
    const host = document.createElement("div");
    renderBlueprintDom(host, proto, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    // `status["__proto__"]` on a plain object hands back `Object.prototype` — an object that is
    // not a BindingStatus and is not undefined either. loom's `resolveWidgetStatus` refuses it,
    // so the widget must see no status at all.
    expect(host.querySelector("[data-widget-id='proto']")?.textContent?.endsWith("|-")).toBe(true);
  });
  it("a binding that declares no status path gets no status, even when the store has one for its handle", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    store.setValue("h-quiet", 5, { state: "stale" });
    const quiet = blueprint$({
      id: "q",
      title: "Q",
      layout: stack({
        children: [
          MetricCard({
            id: "quiet",
            title: "Quiet",
            // Value only: the status channel is opt-in, declared per binding.
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: hydrationPath("h-quiet") },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const { registry } = recording();
    const host = document.createElement("div");
    renderBlueprintDom(host, quiet, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    expect(host.querySelector("[data-widget-id='quiet']")?.textContent).toBe("Quiet=5|-");
    // And it stays absent across updates — the channel is not re-derived from the path.
    store.setValue("h-quiet", 6, { state: "error" });
    await Promise.resolve();
    expect(host.querySelector("[data-widget-id='quiet']")?.textContent).toBe("Quiet=6|-");
  });
  it("a non-hydration projection binding gets no status and still subscribes to its value", async () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register<{ cpu: number }>({
      id: "metrics",
      initialState: { cpu: 0 },
      handlers: { SET: (s, e) => ({ ...s, cpu: (e.payload as { cpu: number }).cpu }) },
    });
    const other = blueprint$({
      id: "o",
      title: "O",
      layout: stack({
        children: [
          MetricCard({
            id: "cpu",
            title: "CPU",
            binding: { projectionId: "metrics", path: "cpu" },
          }),
        ],
      }),
      projections: ["metrics"],
    });
    const { registry } = recording();
    const host = document.createElement("div");
    renderBlueprintDom(host, other, { projectionRuntime: runtime, executionId: "x", registry });
    expect(host.querySelector("[data-widget-id='cpu']")?.textContent).toBe("CPU=0|-");
    runtime.handleEvent({
      id: "1",
      workflowId: "w",
      executionId: "x",
      eventType: "SET",
      sequence: 1,
      timestamp: 0,
      payload: { cpu: 87 },
    });
    await Promise.resolve();
    expect(host.querySelector("[data-widget-id='cpu']")?.textContent).toBe("CPU=87|-");
  });
  it("a status change with an UNCHANGED value re-renders even when the producer stamps no seq", async () => {
    // `BindingStatus.seq` is optional (IR 2.0.0) — only the hydration store happens to stamp
    // one. A comparator that keys on `seq` alone calls every seq-less pair equal and drops the
    // headline transition the matrix exists for: the provider failed, the last value stays.
    const runtime = new InMemoryProjectionRuntime();
    interface Metrics {
      cpu: number;
      health: { state: string; finding?: { code: string; message: string } };
    }
    runtime.register<Metrics>({
      id: "metrics",
      initialState: { cpu: 87, health: { state: "ready" } },
      handlers: {
        FAIL: (s) => ({
          ...s,
          health: { state: "error", finding: { code: "provider-failed", message: "tool down" } },
        }),
      },
    });
    const seqless = blueprint$({
      id: "s",
      title: "S",
      layout: stack({
        children: [
          MetricCard({
            id: "cpu",
            title: "CPU",
            binding: { projectionId: "metrics", path: "cpu", status: { path: "health" } },
          }),
        ],
      }),
      projections: ["metrics"],
    });
    const { registry, calls } = recording();
    const host = document.createElement("div");
    renderBlueprintDom(host, seqless, {
      projectionRuntime: runtime,
      executionId: "x",
      registry,
    });
    expect(host.querySelector("[data-widget-id='cpu']")?.textContent).toBe("CPU=87|ready");
    calls.length = 0;
    runtime.handleEvent({
      id: "1",
      workflowId: "w",
      executionId: "x",
      eventType: "FAIL",
      sequence: 1,
      timestamp: 0,
      payload: {},
    });
    await Promise.resolve();
    expect(calls).toEqual(["update:cpu"]);
    expect(host.querySelector("[data-widget-id='cpu']")?.textContent).toBe("CPU=87|error");
  });
  it("an unregistered projection renders a visible placeholder instead of throwing, and its widgets show undefined until it's registered", () => {
    const runtime = new InMemoryProjectionRuntime();
    const ghost = blueprint$({
      id: "g",
      title: "Ghost",
      layout: stack({
        children: [
          MetricCard({ id: "cpu", title: "CPU", binding: { projectionId: "ghost", path: "cpu" } }),
        ],
      }),
      projections: ["ghost"],
    });
    const { registry } = recording();
    const host = document.createElement("div");
    expect(() =>
      renderBlueprintDom(host, ghost, { projectionRuntime: runtime, executionId: "x", registry })
    ).not.toThrow();
    expect(host.querySelector("[data-placeholder='projection']")?.textContent).toBe(
      '[Projection "ghost" is not registered]'
    );
    expect(host.querySelector("[data-widget-id='cpu']")?.textContent).toBe("CPU=undefined|-");
  });
  it("a dispose that throws still tears down every other widget and removes the element, then rethrows", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const calls: string[] = [];
    const throwingDispose: DomWidgetRenderer = (host, props) => {
      const el = document.createElement("span");
      el.textContent = `${props.widget.title}=${String(props.value)}`;
      host.appendChild(el);
      return {
        update: () => {},
        dispose: () => {
          throw new Error("boom-dispose");
        },
      };
    };
    const recordingDispose: DomWidgetRenderer = (host, props) => {
      const el = document.createElement("span");
      el.textContent = `${props.widget.title}=${String(props.value)}`;
      host.appendChild(el);
      return {
        update: (value, status) => {
          el.textContent = `${props.widget.title}=${String(value)}|${status?.state ?? "-"}`;
          calls.push(`update:${props.widget.id}`);
        },
        dispose: () => calls.push(`dispose:${props.widget.id}`),
      };
    };
    const registry = new RendererRegistry<DomWidgetRenderer>()
      .register("MetricCard", throwingDispose)
      .register("StatusBadge", recordingDispose);
    const host = document.createElement("div");
    const handle = renderBlueprintDom(host, bp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    expect(() => handle.dispose()).toThrow(AggregateError);
    expect(calls).toContain("dispose:phase");
    expect(host.querySelector("[data-blueprint-id='e@v']")).toBeNull();
    calls.length = 0;
    store.setValue("h-phase", "x", { state: "ready" });
    await Promise.resolve();
    expect(calls).not.toContain("update:phase");
  });
  it("IR 2.1.0: a placed cell's grid lines land on the child's own element; an unplaced span-1 cell writes none", () => {
    const placedBp = blueprint$({
      id: "e@p",
      title: "Dash",
      projections: [HYDRATION_PROJECTION_ID],
      layout: grid({
        columns: 12,
        children: [
          cell(4, MetricCard({ id: "p99", title: "p99", binding: bind("h-p99") }), {
            row: 2,
            column: 5,
          }),
          cell(1, StatusBadge({ id: "phase", title: "Phase", binding: bind("h-phase") }), {
            rowSpan: 2,
          }),
          cell(6, stack({ children: [] }), { row: 1, column: 7 }),
          MetricCard({ id: "flow", title: "flow", binding: bind("h-flow") }),
        ],
      }),
    });
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const host = document.createElement("div");
    const handle = renderBlueprintDom(host, placedBp, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: recording().registry,
    });
    const el = (sel: string) => host.querySelector(sel) as HTMLElement;
    const lines = (sel: string) => [el(sel).style.gridColumn, el(sel).style.gridRow];
    expect(lines("[data-widget-id='p99']")).toEqual(["5 / span 4", "2 / span 1"]);
    // Placed ⇒ written even at span 1, exactly as loom's React renderer wraps a placed span-1 cell.
    expect(lines("[data-widget-id='phase']")).toEqual(["span 1", "span 2"]);
    expect(lines("[data-layout='stack']")).toEqual(["7 / span 6", "1 / span 1"]);
    expect(lines("[data-widget-id='flow']")).toEqual(["", ""]);
    // Still no wrapper: the grid item is the widget's own host.
    expect(el("[data-widget-id='p99']").parentElement).toBe(el("[data-layout='grid']"));
    handle.dispose();
  });
});
