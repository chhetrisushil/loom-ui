import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import {
  MetricCard,
  RendererRegistry,
  StatusBadge,
  blueprint$,
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

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: grid({
    columns: 12,
    children: [
      MetricCard({
        id: "p99",
        title: "p99",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.h-p99" },
      }),
      stack({
        children: [
          StatusBadge({
            id: "phase",
            title: "Phase",
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.h-phase" },
          }),
        ],
      }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});
(bp.layout.children[0] as { props: Record<string, unknown> }).props.span = 4;

describe("renderBlueprintDom", () => {
  it("mounts containers and widgets, passes status from the hydration projection, honours span in a grid", () => {
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
    expect(p99Host.style.gridColumn).toBe("span 4");
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
});
