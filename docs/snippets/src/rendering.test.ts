// @vitest-environment happy-dom
// The code of docs/guides/rendering.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { boardBlueprint, boardExperience, boardStore, catalog } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  type Experience,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  compile,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration/client";
import { referenceContainers } from "@loom-ui/renderer-lit/containers";
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
// #endregion imports

const metric = (id: string, order: string, handle: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 12,
  props: { unit: "ms" },
  binding: { handle, priority: "P0" },
});

const provider = (handle: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "read",
      toolName: "metrics.query",
      toolVersion: "1.0.0",
      toolSchemaHash: "sha256:metrics-query-v1",
      arguments: { metric: handle },
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "Named", scriptRef: "to-kpi" },
  outputShapeHash: "",
  outputCheck: "contract",
  cachePolicy: { ttlSeconds: 30, scope: "global" },
});

describe("docs/guides/rendering.md", () => {
  it("renders the same blueprint in a terminal and in the DOM, with a tabbed container", async () => {
    const { runtime, store } = boardStore();
    store.setValue("latency-p50", { value: 180, unit: "ms" }, { state: "ready" });

    // #region tabs
    // A container's `role` is the app-defined key a container renderer is registered under.
    // Each panel is a titled container; the tabs renderer labels a tab from its panel's title.
    const panel = (id: string, title: string): Operation => ({
      type: "insertNode",
      parentId: "views",
      node: {
        id,
        order: id,
        kind: "container",
        direction: "column",
        span: 12,
        title: { key: `views.${id}`, fallback: title },
        children: [],
      },
    });
    const ops: Operation[] = [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "views",
          order: "G",
          kind: "container",
          direction: "column",
          span: 12,
          role: "tabs",
          children: [],
        },
      },
      panel("tail", "Tail"),
      panel("median", "Median"),
      { type: "moveNode", nodeId: "p99", newParentId: "tail", newOrder: "G" },
      { type: "insertNode", parentId: "median", node: metric("p50", "G", "latency-p50") },
    ];
    // #endregion tabs
    const withP50 = replay(boardExperience(), [
      { type: "remapProvider", handle: "latency-p50", spec: provider("latency-p50") },
      { type: "remapProvider", handle: "latency-p99", spec: provider("latency-p99") },
    ]);
    if (!withP50.ok) throw new Error(withP50.finding.message);
    const built = replay(withP50.value, ops);
    if (!built.ok) throw new Error(built.finding.message);
    const experience: Experience = seal(built.value);

    const opts = {
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    };
    const web = compile(experience, { ...opts, surface: "web" });
    const terminal = compile(experience, { ...opts, surface: "terminal" });
    expect(web.findings).toEqual([]);

    // #region terminal
    // No terminal counterpart for container roles: a role prints the plain titled container.
    console.log(renderExperience(terminal.blueprint, store));

    // The host draws its own title bar? Drop the framework kinds' "Title:" prefix.
    console.log(renderExperience(terminal.blueprint, store, { chrome: "host" }));

    // Merge into a registry of your own; never `.register()` on a shared default.
    const mine = terminalRegistry({ chrome: "host" });
    // #endregion terminal
    expect(renderExperience(terminal.blueprint, store)).toContain("Tail");
    expect(mine).toBeDefined();

    const host = document.createElement("div");
    document.body.append(host);
    // #region dom
    const handle = renderBlueprintDom(host, web.blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
      containers: referenceContainers(), // tabs and stepper; the app can add its own roles
      title: "none", // the host page already has a heading
    });
    // #endregion dom
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector("[role=tablist]")).not.toBeNull();
    expect(host.querySelector("h1")).toBeNull();

    // #region recompose
    const revised = replay(experience, [{ type: "setProps", nodeId: "p99", patch: { unit: "s" } }]);
    if (!revised.ok) throw new Error(revised.finding.message);
    const next = compile(seal(revised.value), { ...opts, surface: "web" });
    const report = handle.update(next.blueprint); // patched in place, by node id
    // #endregion recompose
    expect(report.findings).toEqual([]);
    handle.dispose();
    const blueprint = boardBlueprint("web").blueprint;
    expect(blueprint).toBeDefined();
  });

  it("keeps docs/guides/rendering.md in step with this file", () => {
    expectDocMirrors("docs/guides/rendering.md", "rendering.test.ts");
  });
});
