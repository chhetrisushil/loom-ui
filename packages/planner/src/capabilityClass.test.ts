import { type Experience, genesis, replay, toolKey } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { declaredToolClassesFrom, requiredClass } from "./capabilityClass";
import { checkPlannerConformance } from "./conformance";
import type { PlanDraft } from "./contract";
import { materialize } from "./materialize";
import { ReferencePlanner } from "./reference";
import type { CapabilityRef, Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

// U10b: a capability's declared `sensitivity` classes every node bound to it (tool-level,
// fail-closed). The model's proposal may raise the class, never lower it.

const base = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
const declared = (c: "internal" | "sensitive" | "secret"): CapabilityRef[] =>
  capabilitiesFixture.map((cap) =>
    cap.handle === "orders_summary" ? { ...cap, sensitivity: c } : cap
  );

const binding = {
  capability: "orders_summary",
  arguments: { window: "7d" },
  path: "totals.count",
  priority: "P0" as const,
};
// `Metric` is a caller-only type: a draft carrying a class on it would not even parse, so the model
// cannot have proposed one. `Collection` is `model-may-set`.
const metric: PlanDraft = {
  summary: "s",
  nodes: [{ id: "orders", type: "Metric", label: "Orders", span: 4, props: {}, binding }],
};
const collection = (sensitivity?: "internal" | "sensitive" | "secret"): PlanDraft => ({
  summary: "s",
  nodes: [
    {
      id: "skus",
      type: "Collection",
      label: "SKUs",
      span: 8,
      props: { columns: ["sku"] },
      binding: { ...binding, path: "rows", ...(sensitivity !== undefined && { sensitivity }) },
    },
  ],
});
const classOf = (ops: ReturnType<typeof materialize>["ops"], id: string) => {
  const op = ops.find((o) => o.type === "insertNode" && o.node.id === id);
  return op?.type === "insertNode" && op.node.kind === "semantic"
    ? op.node.binding?.sensitivity
    : "NOT-INSERTED";
};

describe("materialize: a capability's declared class classes its bound nodes", () => {
  it("a node on a caller-only type bound to a secret capability is secret though the model proposed nothing", () => {
    const { ops, findings } = materialize(metric, base(), planningCatalog, declared("secret"));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(classOf(ops, "orders")).toBe("secret");
  });
  it("a proposal may raise the class but never lower it", () => {
    expect(
      classOf(
        materialize(collection("internal"), base(), planningCatalog, declared("sensitive")).ops,
        "skus"
      )
    ).toBe("sensitive");
    expect(
      classOf(
        materialize(collection("secret"), base(), planningCatalog, declared("sensitive")).ops,
        "skus"
      )
    ).toBe("secret");
    expect(
      classOf(materialize(collection(), base(), planningCatalog, declared("sensitive")).ops, "skus")
    ).toBe("sensitive");
  });
  it("a capability declaring nothing adds nothing: the node stays unclassified", () => {
    const { ops } = materialize(metric, base(), planningCatalog, capabilitiesFixture);
    expect(classOf(ops, "orders")).toBeUndefined();
  });
  it("revise raises an existing unclassified node bound to a now-declared capability (bindProvider carries the class)", () => {
    const first = materialize(metric, base(), planningCatalog, capabilitiesFixture);
    const exp = replay(base(), first.ops);
    if (!exp.ok) throw new Error(exp.finding.message);
    const second = materialize(metric, exp.value, planningCatalog, declared("secret"));
    const rebind = second.ops.find((o) => o.type === "bindProvider");
    expect(rebind?.type === "bindProvider" && rebind.sensitivity).toBe("secret");
    const applied = replay(exp.value, second.ops);
    if (!applied.ok) throw new Error(applied.finding.message);
    const node =
      applied.value.root.kind === "container" ? applied.value.root.children[0] : undefined;
    expect(node?.kind === "semantic" && node.binding?.sensitivity).toBe("secret");
  });
});

const compose = JSON.stringify({ summary: "s", nodes: metric.nodes });

describe("checkPlannerConformance: bound nodes are classed at least their capability's class", () => {
  const fixture = (planner: Planner) =>
    checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: declared("secret"),
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
  it("the reference planner passes", async () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, compose]),
      modelId: "m",
    });
    const findings = await fixture(planner);
    expect(findings.map((f) => f.code)).not.toContain("binding-class-below-capability");
  });
  it("a planner that leaves the node unclassified fails with binding-class-below-capability", async () => {
    const inner = new ReferencePlanner({ model: scriptedModel([compose, compose]), modelId: "m" });
    // Plans as if the capability declared nothing — the pre-U10b behaviour.
    const lax: Planner = {
      compose: (i, ctx) => inner.compose({ ...i, capabilities: capabilitiesFixture }, ctx),
      revise: (i, ctx) => inner.revise({ ...i, capabilities: capabilitiesFixture }, ctx),
    };
    const findings = await fixture(lax);
    expect(findings.map((f) => f.code)).toContain("binding-class-below-capability");
  });
});

// ---- Fix round 1 ------------------------------------------------------------------------------

const orders = capabilitiesFixture.find((c) => c.handle === "orders_summary") as CapabilityRef;
// The SAME tool offered at two versions: v2 internal, v3 secret. One tool to the read-time floor.
const twoVersions: CapabilityRef[] = [
  { ...orders, sensitivity: "internal" },
  {
    ...orders,
    handle: "orders_v3",
    toolVersion: "3.0.0",
    toolSchemaHash: "sha256:v3",
    sensitivity: "secret",
  },
];
const bound = (ops: ReturnType<typeof materialize>["ops"], id: string) => {
  const op = ops.find((o) => o.type === "insertNode" && o.node.id === id);
  return op?.type === "insertNode" && op.node.kind === "semantic" ? op.node.binding : undefined;
};
const experienceOf = (ops: ReturnType<typeof materialize>["ops"]): Experience => {
  const r = replay(base(), ops);
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const semantic = (e: Experience, id: string) => {
  const kids = e.root.kind === "container" ? e.root.children : [];
  const n = kids.find((c) => c.id === id);
  return n?.kind === "semantic" ? n : undefined;
};

describe("requiredClass / declaredToolClassesFrom: one derivation per toolKey", () => {
  it("joins every capability of the same tool, whatever its version", () => {
    expect(declaredToolClassesFrom(twoVersions)[toolKey(orders)]).toBe("secret");
    const spec = experienceOf(
      materialize(metric, base(), planningCatalog, twoVersions).ops
    ).providers;
    const only = Object.values(spec)[0];
    if (only === undefined) throw new Error("no provider");
    expect(requiredClass(only, twoVersions)).toBe("secret");
    expect(requiredClass(only, capabilitiesFixture)).toBeUndefined();
  });
});

describe("materialize: the same tool at two versions is classed at the strictest", () => {
  it("a node bound to the INTERNAL version is still secret (the other version declares secret)", () => {
    const { ops } = materialize(metric, base(), planningCatalog, twoVersions);
    expect(bound(ops, "orders")?.sensitivity).toBe("secret");
  });
  it("conformance and materialize agree: the reference planner passes its own kit", async () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, compose]),
      modelId: "m",
    });
    const findings = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: twoVersions,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(findings.map((f) => f.code)).not.toContain("binding-class-below-capability");
  });
});

describe("materialize: a kept upstream graph's tools count", () => {
  // Upstream step `up` calls a secret tool; the terminal calls a plain one.
  const upstreamTool: CapabilityRef = {
    ...orders,
    handle: "payroll",
    toolName: "payroll.read",
    toolVersion: "1.0.0",
    toolSchemaHash: "sha256:p",
    sensitivity: "secret",
  };
  it("a revise that keeps a graph whose upstream step is secret never stamps the node weaker", () => {
    const first = materialize(metric, base(), planningCatalog, capabilitiesFixture);
    const exp = experienceOf(first.ops);
    // Splice an upstream secret step into the node's stored graph (an app-authored multi-step call).
    const node = semantic(exp, "orders");
    const h = node?.binding?.handle as string;
    const spec = exp.providers[h];
    if (spec === undefined) throw new Error("no spec");
    const term = spec.executionGraph[0] as ProviderSpecStep;
    const withUp = {
      ...spec,
      executionGraph: [
        {
          ...term,
          stepId: "up",
          toolName: "payroll.read",
          toolVersion: "1.0.0",
          toolSchemaHash: "sha256:p",
          dependsOn: [],
        },
        { ...term, dependsOn: ["up"] },
      ],
    };
    const patched: Experience = { ...exp, providers: { ...exp.providers, [h]: withUp } };
    const caps = [...capabilitiesFixture, upstreamTool];
    const out = materialize(metric, patched, planningCatalog, caps);
    const applied = replay(patched, out.ops);
    if (!applied.ok) throw new Error(applied.finding.message);
    const after = semantic(applied.value, "orders");
    const spec2 = after?.binding && applied.value.providers[after.binding.handle];
    expect(spec2 && requiredClass(spec2, caps)).toBe("secret");
    expect(after?.binding?.sensitivity).toBe("secret");
  });
});
type ProviderSpecStep = Experience["providers"][string]["executionGraph"][number];

describe("materialize: keep paths carry the declared class", () => {
  const draftOrders = (window: string): PlanDraft => ({
    summary: "s",
    nodes: [
      {
        id: "orders",
        type: "Metric",
        label: "Orders",
        span: 4,
        props: {},
        binding: { ...binding, arguments: { window } },
      },
      {
        id: "other",
        type: "Metric",
        label: "Other",
        span: 4,
        props: {},
        binding: { ...binding, arguments: { window: "30d" } },
      },
    ],
  });
  const seeded = () => {
    const first = materialize(draftOrders("7d"), base(), planningCatalog, capabilitiesFixture);
    const exp = experienceOf(first.ops);
    const other = semantic(exp, "other")?.binding?.handle as string;
    return { exp, other };
  };
  const classAfter = (exp: Experience, ops: ReturnType<typeof materialize>["ops"], id: string) => {
    const r = replay(exp, ops);
    if (!r.ok) throw new Error(r.finding.message);
    return semantic(r.value, id)?.binding?.sensitivity;
  };
  it("M4: sample-not-observed keeps the binding but never below the declared class", () => {
    const { exp, other } = seeded();
    // `other`'s call was observed; `orders` re-binds a call nobody observed -> its binding is kept.
    const out = materialize(draftOrders("1d"), exp, planningCatalog, declared("secret"), {
      [other]: { window: "30d", totals: { count: 3 } },
    } as never);
    expect(out.findings.map((f) => f.code)).toContain("sample-not-observed");
    expect(classAfter(exp, out.ops, "orders")).toBe("secret");
  });
  it("M7: a handle already in the base is re-bound at the declared class", () => {
    const { exp } = seeded();
    const out = materialize(draftOrders("7d"), exp, planningCatalog, declared("secret"));
    const rebind = out.ops.find((o) => o.type === "bindProvider" && o.nodeId === "orders");
    expect(rebind?.type === "bindProvider" && rebind.sensitivity).toBe("secret");
    expect(classAfter(exp, out.ops, "orders")).toBe("secret");
  });
});

describe("checkPlannerConformance: the revise check (M6)", () => {
  it("a planner lax ONLY on revise fails with a revise-labelled finding", async () => {
    // The revise ADDS a second node on the secret tool; compose is untouched and correct.
    const withExtra = JSON.stringify({
      summary: "s",
      nodes: [
        ...metric.nodes,
        { id: "orders2", type: "Metric", label: "Orders again", span: 4, props: {}, binding },
      ],
    });
    const inner = new ReferencePlanner({
      model: scriptedModel([compose, withExtra]),
      modelId: "m",
    });
    const lax: Planner = {
      compose: (i, ctx) => inner.compose(i, ctx),
      revise: (i, ctx) => inner.revise({ ...i, capabilities: capabilitiesFixture }, ctx),
    };
    const findings = await checkPlannerConformance(lax, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: declared("secret"),
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    const hits = findings.filter((f) => f.code === "binding-class-below-capability");
    expect(hits.some((f) => f.message.startsWith("revise:"))).toBe(true);
    expect(hits.some((f) => f.message.startsWith("compose:"))).toBe(false);
  });
});
