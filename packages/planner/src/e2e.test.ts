import {
  compile,
  experienceHandles,
  genesis,
  hydrationPath,
  hydrationStatusPath,
  isContainer,
  loomCatalogFor,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration";
import { renderExperience } from "@loom-ui/renderer-terminal";
import { type Layout, type Widget, validateBlueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { ReferencePlanner } from "./reference";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

const compose = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders (7d)",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    {
      id: "top_skus",
      type: "Collection",
      label: "Top SKUs",
      span: 8,
      props: { columns: ["sku", "units"] },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "rows",
        priority: "P1",
      },
    },
  ],
});
const revise = JSON.stringify({
  summary: "s",
  nodes: [
    ...(JSON.parse(compose) as { nodes: unknown[] }).nodes,
    { id: "why", type: "Insight", label: "Why volume moved", span: 12, props: { tone: "neutral" } },
  ],
});

/** Every widget in a blueprint's layout, grid cells unwrapped. */
const widgetsOf = (node: Widget | Layout): Widget[] =>
  "_tag" in node
    ? [node]
    : node.type === "grid"
      ? node.children.flatMap((c) => widgetsOf(c.node))
      : node.children.flatMap(widgetsOf);

describe("intent → artifact → compile → revise → new artifact → recompile → terminal", () => {
  it("runs end to end with a scripted planner, only the new node's id is new, and the same artifact renders on the terminal with hydration status", async () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, revise]),
      modelId: "scripted",
    });
    const ctx = recordingContext();
    const composed = await planner.compose(
      { intent: intentFixture, catalog: planningCatalog, capabilities: capabilitiesFixture },
      ctx
    );
    const g = genesis({ experienceId: "e2e", intent: intentFixture, meta: metaFixture });
    const a1 = replay(g, composed.ops);
    if (!a1.ok) throw new Error(a1.finding.message);
    const v1 = seal(a1.value);

    const web = compile(v1, {
      surface: "web",
      catalog: planningCatalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    expect(web.ok).toBe(true);
    if (!web.ok) throw new Error("web compile failed");
    expect(
      validateBlueprint(web.blueprint, loomCatalogFor(planningCatalog, "web").catalog).ok
    ).toBe(true);
    expect(web.blueprint.id).toBe(`${v1.experienceId}@${v1.versionHash}`);
    // IR 2.0.0: every bound widget declares a status channel beside its value path, in the same
    // projection state — that is what the renderer reads delivery state off, below.
    const ordersWidget = widgetsOf(web.blueprint.layout).find((w) => w.id === "orders");
    const ordersBinding = experienceHandles(v1).find((u) => u.nodeIds.includes("orders"));
    if (ordersBinding === undefined) throw new Error("expected a handle for orders");
    expect(ordersWidget?.binding?.path).toBe(hydrationPath(ordersBinding.handle));
    expect(ordersWidget?.binding?.status?.path).toBe(hydrationStatusPath(ordersBinding.handle));
    // The reference planner composes into genesis' default root, a 12-column grid: the spans the
    // model chose (COMPOSE_SYSTEM promises "a 12-column row") ride in cells, never dropped.
    expect(web.blueprint.layout.type).toBe("grid");
    const webGrid = web.blueprint.layout as Extract<Layout, { type: "grid" }>;
    expect(webGrid.columns).toBe(12);
    expect(
      webGrid.children.map((c) => ["_tag" in c.node ? c.node.id : c.node.type, c.span])
    ).toEqual([
      ["orders", 4],
      ["top_skus", 8],
    ]);

    const revised = await planner.revise(
      {
        experience: v1,
        request: { text: "add an insight explaining the trend" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      ctx
    );
    expect(revised.ops).toHaveLength(1);
    const a2 = replay(v1, revised.ops);
    if (!a2.ok) throw new Error(a2.finding.message);
    const v2 = seal(a2.value);
    expect(v2.versionHash).not.toBe(v1.versionHash);
    if (!isContainer(v1.root) || !isContainer(v2.root)) throw new Error("root is not a container");
    const ids1 = v1.root.children.map((c) => c.id);
    const ids2 = v2.root.children.map((c) => c.id);
    expect(ids2.filter((id) => !ids1.includes(id))).toEqual(["why"]);
    expect(ids1.every((id) => ids2.includes(id))).toBe(true);

    const term = compile(v2, {
      surface: "terminal",
      catalog: planningCatalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    expect(term.ok).toBe(true);
    if (!term.ok) throw new Error("terminal compile failed");
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: v2.experienceId });
    const uses = experienceHandles(v2);
    const ordersHandle = uses.find((u) => u.nodeIds.includes("orders"));
    const topSkusHandle = uses.find((u) => u.nodeIds.includes("top_skus"));
    if (ordersHandle === undefined || topSkusHandle === undefined)
      throw new Error("expected handles for orders and top_skus");
    store.setValue(ordersHandle.handle, 412, { state: "ready" });
    store.setStatus(topSkusHandle.handle, { state: "pending" });
    const frame = renderExperience(term.blueprint, store);
    expect(frame).toContain("Orders (7d)");
    expect(frame).toContain("412");
    expect(frame).toContain("⋯ Top SKUs");
    expect(frame).toContain("Why volume moved");
  });
});
