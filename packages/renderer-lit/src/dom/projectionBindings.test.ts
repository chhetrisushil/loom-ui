import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { HydrationStore } from "@loom-ui/hydration";
import { InMemoryProjectionRuntime, type Projection } from "@loom/projection-runtime";
import { afterEach, describe, expect, it } from "vitest";
import "../widgets/index";
import { litRegistry } from "./litRegistry";
import { renderBlueprintDom } from "./renderBlueprintDom";

type EventEnvelope = Parameters<InMemoryProjectionRuntime["handleEvent"]>[0];

// A node bound to a projection that is NOT hydration: the Blueprint names it, and the DOM adapter
// reads and subscribes to it exactly as it does the hydration projection — one runtime, one
// execution id, any number of projections. These tests run the whole chain: compile → mount →
// publish to the other projection → the widget updates, with no hydration involved.

interface AgentState {
  readonly state: Record<string, string>;
  readonly status: Record<string, { state: "ready" | "pending"; seq: number }>;
}
const AGENT_EVENT = "AGENT_SET";
const agentProjection: Projection<AgentState> = {
  id: "agent-status",
  version: "2",
  initialState: { state: {}, status: {} },
  handlers: {
    [AGENT_EVENT]: (s, e) => {
      const p = e.payload as { key: string; value: string; seq: number };
      return {
        state: { ...s.state, [p.key]: p.value },
        status: { ...s.status, [p.key]: { state: "ready", seq: p.seq } },
      };
    },
  },
};
const publish = (
  rt: InMemoryProjectionRuntime,
  executionId: string,
  key: string,
  value: string,
  seq: number
) =>
  rt.handleEvent({
    id: `a-${seq}`,
    workflowId: "w",
    executionId,
    eventType: AGENT_EVENT,
    sequence: seq,
    timestamp: 0,
    payload: { key, value, seq },
  } as EventEnvelope);

const catalog = defineSemanticCatalog({
  id: "proj-test",
  entries: [
    {
      name: "Phase",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "StatusBadge" } },
    },
    {
      name: "Explainer",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { kind: "Note", props: ["text"], binding: "none" } },
    },
  ],
});
const g = genesis({
  experienceId: "pe",
  intent: { objective: "agents", source: "user" },
  meta: { author: "t", createdAt: "2026-10-05T00:00:00Z", sourceKind: "prompt" },
});
const node = (extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id: "ph",
  order: "A",
  kind: "semantic",
  type: "Phase",
  typeVersion: "1.0.0",
  span: 6,
  label: { key: "k", fallback: "Agent" },
  props: {},
  projection: { id: "agent-status", path: "state.a1", statusPath: "status.a1", version: "2" },
  ...extra,
});
const exp = (n: SemanticNode) => ({
  ...g,
  versionHash: "sha256:pe",
  root: { ...(g.root as ContainerNode), children: [n] },
});
const compileOpts = {
  surface: "web" as const,
  catalog,
  hydrationProjectionId: "loom-ui.hydration",
  hydrationProjectionVersion: "1.1.0",
  projections: [{ id: "agent-status", version: "2", sensitivity: "internal" as const }],
};

let hosts: HTMLElement[] = [];
afterEach(() => {
  for (const h of hosts) h.remove();
  hosts = [];
});
const mount = (): HTMLElement => {
  const h = document.createElement("div");
  document.body.appendChild(h);
  hosts.push(h);
  return h;
};
const badgeText = (host: HTMLElement): string =>
  (host.querySelector("[data-widget-id='ph'] lu-status-badge")?.shadowRoot?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

describe("renderBlueprintDom with a non-hydration projection", () => {
  it("renders live updates from a projection that is not the hydration projection", async () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(agentProjection);
    const store = new HydrationStore(runtime, { experienceId: "pe" });
    const { blueprint, ok } = compile(exp(node()), {
      ...compileOpts,
      viewer: { clearance: "internal" },
    });
    expect(ok).toBe(true);
    expect(blueprint.projections).toEqual(["loom-ui.hydration", "agent-status"]);
    const host = mount();
    const handle = renderBlueprintDom(host, blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });
    expect(host.querySelector("[data-placeholder='projection']")).toBeNull();
    publish(runtime, store.executionId, "a1", "triaging", 1);
    await Promise.resolve();
    const el = host.querySelector("[data-widget-id='ph'] lu-status-badge") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await el.updateComplete;
    expect(badgeText(host)).toContain("triaging");
    publish(runtime, store.executionId, "a1", "resolved", 2);
    await Promise.resolve();
    await el.updateComplete;
    expect(badgeText(host)).toContain("resolved");
    handle.dispose();
  });

  it("an unregistered projection is the placeholder, not a thrown mount", () => {
    const runtime = new InMemoryProjectionRuntime();
    const { blueprint } = compile(exp(node()), {
      ...compileOpts,
      viewer: { clearance: "internal" },
    });
    const host = mount();
    renderBlueprintDom(host, blueprint, {
      projectionRuntime: runtime,
      executionId: "pe",
      registry: litRegistry,
    });
    const ids = [...host.querySelectorAll("[data-placeholder='projection']")].map((p) =>
      p.getAttribute("data-projection-id")
    );
    expect(ids).toContain("agent-status");
  });

  it("a viewer without clearance gets a static note: no binding, so nothing subscribes or reads", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(agentProjection);
    const { blueprint } = compile(exp(node()), { ...compileOpts, viewer: {} });
    expect(blueprint.projections).toEqual(["loom-ui.hydration"]);
    const host = mount();
    renderBlueprintDom(host, blueprint, {
      projectionRuntime: runtime,
      executionId: "pe",
      registry: litRegistry,
    });
    publish(runtime, "pe", "a1", "secret-state", 1);
    expect(host.textContent).not.toContain("secret-state");
    expect(host.textContent).not.toContain("agent-status");
  });
});
