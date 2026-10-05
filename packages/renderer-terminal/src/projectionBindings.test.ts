import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { HydrationStore } from "@loom-ui/hydration";
import { InMemoryProjectionRuntime, type Projection } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";
import { watch } from "./watch";

type EventEnvelope = Parameters<InMemoryProjectionRuntime["handleEvent"]>[0];

// A node bound to a non-hydration projection, drawn on the terminal: the host supplies that
// projection's state (`projectionState`) and, for `watch`, how to hear it change.

const proj: Projection<{ state: Record<string, number> }> = {
  id: "queue",
  version: "3",
  initialState: { state: {} },
  handlers: {
    SET: (s, e) => ({ state: { ...s.state, ...(e.payload as Record<string, number>) } }),
  },
};
const catalog = defineSemanticCatalog({
  id: "t",
  entries: [
    {
      name: "Count",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { terminal: { kind: "MetricCard" } },
    },
    {
      name: "Explainer",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { terminal: { kind: "Note", props: ["text"], binding: "none" } },
    },
  ],
});
const g = genesis({
  experienceId: "te",
  intent: { objective: "queue", source: "user" },
  meta: { author: "t", createdAt: "2026-10-05T00:00:00Z", sourceKind: "prompt" },
});
const n: SemanticNode = {
  id: "q",
  order: "A",
  kind: "semantic",
  type: "Count",
  typeVersion: "1.0.0",
  span: 6,
  label: { key: "k", fallback: "Pending" },
  props: {},
  projection: { id: "queue", path: "state.pending", version: "3" },
};
const exp = {
  ...g,
  versionHash: "sha256:te",
  root: { ...(g.root as ContainerNode), children: [n] },
};
const { blueprint } = compile(exp, {
  surface: "terminal",
  catalog,
  hydrationProjectionId: "loom-ui.hydration",
  hydrationProjectionVersion: "1.1.0",
  projections: [{ id: "queue", version: "3" }],
});
const send = (
  rt: InMemoryProjectionRuntime,
  executionId: string,
  payload: Record<string, number>,
  sequence: number
) =>
  rt.handleEvent({
    id: `s${sequence}`,
    workflowId: "w",
    executionId,
    eventType: "SET",
    sequence,
    timestamp: 0,
    payload,
  } as EventEnvelope);

describe("renderExperience with a non-hydration projection", () => {
  it("is loading when the host supplies no state for the projection", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "te" });
    expect(renderExperience(blueprint, store)).not.toContain("Pending: 7");
  });

  it("draws the value the host's projection state holds, and refuses to read the hydration id through it", () => {
    const rt = new InMemoryProjectionRuntime();
    rt.register(proj);
    const store = new HydrationStore(rt, { experienceId: "te" });
    send(rt, store.executionId, { pending: 7 }, 1);
    const asked: string[] = [];
    const out = renderExperience(blueprint, store, {
      projectionState: (id) => {
        asked.push(id);
        return rt.getState(id, store.executionId);
      },
    });
    expect(out).toContain("Pending: 7");
    expect(asked).toEqual(["queue"]);
  });

  it("a throwing state supplier is a loading row, not a thrown render", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "te" });
    expect(() =>
      renderExperience(blueprint, store, {
        projectionState: () => {
          throw new Error("boom");
        },
      })
    ).not.toThrow();
  });

  it("watch re-renders on a change to the other projection, and stops after unsubscribe", () => {
    const rt = new InMemoryProjectionRuntime();
    rt.register(proj);
    const store = new HydrationStore(rt, { experienceId: "te" });
    const frames: string[] = [];
    const stop = watch(blueprint, store, (f) => frames.push(f), {
      projectionState: (id) => rt.getState(id, store.executionId),
      projectionSubscribe: (onChange) => rt.subscribe("queue", store.executionId, onChange),
    });
    expect(frames).toHaveLength(1);
    send(rt, store.executionId, { pending: 3 }, 1);
    expect(frames.at(-1)).toContain("Pending: 3");
    stop();
    const before = frames.length;
    send(rt, store.executionId, { pending: 4 }, 2);
    expect(frames).toHaveLength(before);
  });
});
