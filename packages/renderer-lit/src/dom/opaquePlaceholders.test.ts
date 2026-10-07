import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
  placeholderAlias,
} from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import type { DomWidgetRenderer } from "./index";
import { renderBlueprintDom } from "./index";

// U10c: a restricted placeholder is emitted under a keyed ALIAS, stable across versions, so the
// renderer's keyed reconcile keeps the SAME element in place (zero remounts) while the DOM never
// carries the lexical id of the node it hides.

const catalog = defineSemanticCatalog({
  id: "u10c",
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
const KEY = "renderer-lit-u10c-key-0123456789";
const REAL = "payroll_salary_by_employee";
const g = genesis({
  experienceId: "u10c",
  intent: { objective: "review", source: "user" },
  meta: { author: "t", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" },
});
const fig = (id: string, order: string, sensitivity?: "sensitive"): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Figure",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: `h_${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const version = (hash: string, children: SemanticNode[]) => ({
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
const compileFor = (exp: ReturnType<typeof version>) =>
  compile(exp, {
    surface: "web",
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: "1.0.0",
    viewer: { clearance: "internal" },
    placeholderKey: KEY,
  });

describe("U10c on the web renderer: a restricted placeholder reconciles in place", () => {
  it("keeps the SAME element across a recompose that inserts siblings, and never carries the real id", () => {
    const calls: string[] = [];
    const draw: DomWidgetRenderer = (host, props) => {
      const el = document.createElement("span");
      el.textContent = props.widget.title ?? "";
      host.appendChild(el);
      calls.push(`mount:${props.widget.id}`);
      return {
        update: () => {},
        patch: (_w: Widget) => {},
        dispose: () => calls.push(`dispose:${props.widget.id}`),
      };
    };
    const registry = new RendererRegistry<DomWidgetRenderer>()
      .register("MetricCard", draw)
      .register("Note", draw);

    const v1 = compileFor(version("sha256:1", [fig("latency", "A"), fig(REAL, "B", "sensitive")]));
    const v2 = compileFor(
      version("sha256:2", [
        fig("errors", "A0"),
        fig("latency", "A"),
        fig(REAL, "B", "sensitive"),
        fig("traffic", "C"),
      ])
    );
    const alias = placeholderAlias(KEY, "u10c", REAL);
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "u10c" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderBlueprintDom(host, v1.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry,
    });
    const before = host.querySelector(`[data-widget-id='${alias}']`);
    expect(before).not.toBeNull();
    expect(host.innerHTML).not.toContain(REAL);
    expect(host.innerHTML).not.toContain("payroll");

    calls.length = 0;
    const report = handle.update(v2.blueprint);
    expect(report.remounted).toEqual([]);
    expect(calls.filter((c) => c.includes(alias))).toEqual([]); // not remounted, not disposed
    expect(host.querySelector(`[data-widget-id='${alias}']`)).toBe(before); // the very same element
    expect(host.innerHTML).not.toContain("payroll");
    // unrestricted nodes keep their own ids (a refine addresses them by data-widget-id)
    expect(host.querySelector("[data-widget-id='latency']")).not.toBeNull();
    handle.dispose();
    host.remove();
  });
});
