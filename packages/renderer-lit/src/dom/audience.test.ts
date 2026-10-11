import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import type { DomWidgetRenderer } from "./index";
import { renderBlueprintDom } from "./index";

// IR 2.5.0 on the web renderer: a widget withheld for the audience draws loom's constant marker
// and nothing else, on first draw AND after a recompose in either direction.

const catalog = defineSemanticCatalog({
  id: "aud",
  entries: [
    {
      name: "Figure",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "MetricCard", props: [], binding: "required" } },
    },
  ],
});
const g = genesis({
  experienceId: "aud",
  intent: { objective: "wall", source: "user" },
  meta: { author: "t", createdAt: "2026-10-11T00:00:00Z", sourceKind: "prompt" },
});
const fig = (id: string, order: string, sensitivity?: "secret"): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Figure",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  label: { key: id, fallback: `Label ${id}` },
  binding: { handle: `h_${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const exp = (hash: string, children: SemanticNode[]) => ({
  ...g,
  versionHash: hash,
  root: { ...(g.root as ContainerNode), children },
  providers: Object.fromEntries(
    children.map((c) => [
      c.binding?.handle ?? "",
      {
        handle: c.binding?.handle ?? "",
        executionGraph: [],
        reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
        outputShapeHash: "sha256:o",
        cachePolicy: { ttlSeconds: 60, scope: "global" as const },
      },
    ])
  ),
});
const compileFor = (e: ReturnType<typeof exp>, audience?: "broadcast") =>
  compile(e, {
    surface: "web",
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: "1.0.0",
    viewer: { clearance: "secret" },
    placeholderKey: "renderer-lit-audience-key-0123456789",
    ...(audience && { audience }),
  });

const rig = () => {
  const mounted: string[] = [];
  const draw: DomWidgetRenderer = (host, props) => {
    const el = document.createElement("span");
    el.textContent = `${props.widget.title ?? ""}|${JSON.stringify(props.value)}`;
    host.appendChild(el);
    mounted.push(props.widget.id);
    return { update: () => {}, patch: (_w: Widget) => {}, dispose: () => {} };
  };
  const registry = new RendererRegistry<DomWidgetRenderer>()
    .register("MetricCard", draw)
    .register("Note", draw);
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "aud" });
  store.setValue("h_pay", "SECRET-VALUE-7", { state: "ready" });
  store.setValue("h_pub", 42, { state: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  return { mounted, registry, runtime, store, host };
};
const SECRETS = ["SECRET-VALUE-7", "Label pay", "h_pay", "MetricCard", "pay"];

describe("a redacted widget on the web renderer", () => {
  it("draws only the constant marker: no renderer, no kind, no title, no value, no source attributes", () => {
    const { mounted, registry, runtime, store, host } = rig();
    const wall = compileFor(
      exp("sha256:1", [fig("pay", "A", "secret"), fig("pub", "B")]),
      "broadcast"
    );
    const handle = renderBlueprintDom(host, wall.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    const red = host.querySelector("[data-binding-state='redacted']") as HTMLElement;
    expect(red).not.toBeNull();
    expect(red.textContent).toBe("⊘ redacted");
    expect(red.querySelector("[data-binding-marker='redacted'][role='status']")).not.toBeNull();
    for (const a of ["data-widget-kind", "data-source-type", "data-degraded", "title"])
      expect(red.hasAttribute(a), a).toBe(false);
    // The Note renderer never ran for it; only the unclassified sibling mounted.
    expect(mounted).toEqual(["pub"]);
    const html = host.innerHTML;
    for (const s of SECRETS.slice(0, 3)) expect(html, s).not.toContain(s);
    expect(host.querySelector("[data-widget-id='pub']")?.textContent).toContain("42");
    handle.dispose();
    host.remove();
  });

  it("a forged redacted widget that still carries a binding and title draws the marker and subscribes to nothing", () => {
    const { mounted, registry, runtime, store, host } = rig();
    const wall = compileFor(exp("sha256:1", [fig("pay", "A"), fig("pub", "B")]));
    const forged = structuredClone(wall.blueprint);
    const cells = (forged.layout as { children: Array<{ node: Widget }> }).children;
    const w = cells.map((c) => c.node).find((n) => n.id === "pay") as Widget;
    (w as { source: unknown }).source = { type: "Figure", version: "1.0.0", redacted: true };
    const handle = renderBlueprintDom(host, forged, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    const el = host.querySelector("[data-widget-id='pay']") as HTMLElement;
    expect(el.textContent).toBe("⊘ redacted");
    expect(el.hasAttribute("data-widget-kind")).toBe(false);
    expect(mounted).toEqual(["pub"]);
    // Live data for the withheld binding changes: still nothing.
    store.setValue("h_pay", "SECRET-VALUE-8", { state: "ready" });
    expect(host.innerHTML).not.toContain("SECRET-VALUE");
    handle.dispose();
    host.remove();
  });

  it("a recompose from a visible widget to a redacted one (same id) clears its content; and back", () => {
    const { registry, runtime, store, host } = rig();
    // Same experience, two audiences: the widget "pay" is visible first, then withheld.
    const e = exp("sha256:1", [fig("pay", "A", "secret"), fig("pub", "B")]);
    const own = compileFor(e);
    const wall = compileFor(e, "broadcast");
    const handle = renderBlueprintDom(host, own.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    expect(host.textContent).toContain("SECRET-VALUE-7");
    expect(host.querySelector("[data-widget-id='pay']")?.getAttribute("data-widget-kind")).toBe(
      "MetricCard"
    );
    handle.update(wall.blueprint);
    expect(host.innerHTML).not.toContain("SECRET-VALUE-7");
    expect(host.innerHTML).not.toContain("Label pay");
    expect(host.querySelector("[data-binding-state='redacted']")?.textContent).toBe("⊘ redacted");
    expect(host.querySelectorAll("[data-widget-kind='MetricCard']")).toHaveLength(1);
    handle.update(own.blueprint);
    expect(host.querySelector("[data-binding-state='redacted']")).toBeNull();
    expect(host.textContent).toContain("SECRET-VALUE-7");
    handle.dispose();
    host.remove();
  });
  it("a SAME-id widget that turns redacted is remounted, never patched with the withheld content; and back", () => {
    const { registry, runtime, store, host } = rig();
    const own = compileFor(exp("sha256:1", [fig("pay", "A"), fig("pub", "B")]));
    const marked = structuredClone(own.blueprint);
    const cells = (marked.layout as { children: Array<{ node: Widget }> }).children;
    const at = cells.findIndex((c) => c.node.id === "pay");
    const cell = cells[at] as { node: Widget };
    cell.node = {
      _tag: "Widget",
      id: "pay",
      kind: "MetricCard",
      props: {},
      source: { type: "redacted", version: "1", redacted: true },
    };
    const handle = renderBlueprintDom(host, own.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    expect(host.querySelector("[data-widget-id='pay']")?.textContent).toContain("Label pay");
    const report = handle.update(marked);
    expect(report.remounted).toEqual(["pay"]);
    const el = host.querySelector("[data-widget-id='pay']") as HTMLElement;
    expect(el.textContent).toBe("⊘ redacted");
    expect(el.hasAttribute("data-widget-kind")).toBe(false);
    handle.update(own.blueprint);
    expect(host.querySelector("[data-widget-id='pay']")?.textContent).toContain("Label pay");
    expect(host.querySelector("[data-binding-state='redacted']")).toBeNull();
    handle.dispose();
    host.remove();
  });
});
