import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { type DriftReport, HydrationController } from "./controller";
import { HYDRATION_PROJECTION_VERSION, HydrationStore } from "./projection";
import { executeProvider, outcomeResult } from "./provider";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// ── An empty upstream is "no data", never an error (loom ADR 0100) ────────────
// A dependent step templated on `{{steps.<up>.output.rows[0].…}}` over an upstream that answered
// with NO rows (or too few) is `empty`: the upstream answered, and the subject is absent. Any
// other miss is a bad path and stays an error. `empty` has no value, so it is never cached, and
// it is not drift, so nothing is ever repaired for it.

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };

/** `top` lists rows; `detail` looks the first one up; `more` depends on `detail`. */
const graph = (path = "rows[0].sku", extra: ReturnType<typeof mcpStep>[] = []) =>
  providerSpec("h", [
    mcpStep("top", "db.top"),
    mcpStep("detail", "db.detail", { sku: `{{steps.top.output.${path}}}` }, ["top"]),
    ...extra,
  ]);

const server = (rows: () => unknown, fail: ReadonlySet<string> = new Set()) =>
  new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
    const i = input as McpIn;
    if (fail.has(i.toolName)) throw new TypedFailure("toolNotFound", { toolName: i.toolName });
    if (i.toolName === "db.top") return { rows: rows() };
    return { sku: i.args.sku, qty: 3 };
  });

describe("executeProvider — upstream-empty", () => {
  it("rows[0] over rows: [] is an EMPTY outcome carrying upstream-empty; the dependent tool is never called", async () => {
    const inv = server(() => []);
    const r = await executeProvider(graph(), { invoker: inv });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding).toMatchObject({ code: "upstream-empty", severity: "warn" });
    expect(r.drift).toEqual([]);
    expect(r.findings.map((f) => f.code)).toContain("upstream-empty");
    expect(inv.calls.map((c) => (c.input as McpIn).toolName)).toEqual(["db.top"]);
    expect(outcomeResult(r)).toEqual({ state: "empty", finding: r.finding });
  });

  it("rows[3] over two rows is empty; its dependents are skipped, and the provider is still empty", async () => {
    const r = await executeProvider(
      graph("rows[3].sku", [mcpStep("more", "db.more", {}, ["detail"])]),
      { invoker: server(() => [{ sku: "a" }, { sku: "b" }]) }
    );
    expect(outcomeResult(r).state).toBe("empty");
    expect(!r.ok && r.findings.map((f) => f.code)).toEqual(["upstream-empty", "dependency-failed"]);
  });

  it("a bad path is an error: a misspelt key, an index on an object, a step outside the graph", async () => {
    for (const [path, rows] of [
      ["rows[0].skuu", [{ sku: "a" }]],
      ["rows[0]", { 0: { sku: "a" } }],
    ] as const) {
      const r = await executeProvider(graph(path), { invoker: server(() => rows) });
      expect(!r.ok && r.finding.code).toBe("provider-failed");
      expect(!r.ok && r.findings.map((f) => f.code)).toContain("unresolved-step-reference");
      expect(outcomeResult(r).state).toBe("error");
    }
    const ghost = providerSpec("h", [
      mcpStep("detail", "db.detail", { sku: "{{steps.ghost.output.rows[0].sku}}" }),
    ]);
    const r = await executeProvider(ghost, { invoker: server(() => []) });
    expect(outcomeResult(r).state).toBe("error");
  });

  it("an empty upstream beside an unrelated tool failure in the same graph is an error", async () => {
    const r = await executeProvider(graph("rows[0].sku", [mcpStep("side", "db.side")]), {
      invoker: server(() => [], new Set(["db.side"])),
    });
    expect(!r.ok && r.finding.code).toBe("provider-failed");
    expect(outcomeResult(r).state).toBe("error");
  });

  it("the value is cleared: an empty outcome carries no value at all", async () => {
    const r = outcomeResult(await executeProvider(graph(), { invoker: server(() => []) }));
    expect(Object.hasOwn(r, "value")).toBe(false);
  });
});

// ── The controller: published, cleared, never cached, never drift ─────────────

const meta = { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" };
const node: SemanticNode = {
  id: "n",
  order: "n",
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle: "h", priority: "P0" },
};
const experience = (): Experience => {
  const g = genesis({ experienceId: "exp", intent: { objective: "x", source: "user" }, meta });
  return {
    ...g,
    versionHash: "v1",
    root: { ...(g.root as ContainerNode), children: [node] },
    providers: { h: graph() },
  };
};

const rig = (rows: () => unknown) => {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp" });
  const clock = new ManualClock();
  const cache = new HydrationCache(clock.now);
  const drifts: DriftReport[] = [];
  const inv = server(rows);
  const ctl = new HydrationController({
    contentRefArgs: "none" as const,
    invoker: inv,
    store,
    cache,
    clock: clock.now,
    setTimer: clock.setTimer,
    onDrift: (d) => drifts.push(d),
  });
  return { store, cache, drifts, inv, ctl };
};

describe("HydrationController — empty", () => {
  it("publishes status empty with the upstream-empty finding and no value; nothing drifts", async () => {
    const { store, drifts, ctl } = rig(() => []);
    ctl.load(experience());
    await flush();
    expect(store.status("h")).toMatchObject({
      state: "empty",
      finding: { code: "upstream-empty", severity: "warn" },
    });
    expect(Object.hasOwn(store.state().values, "h")).toBe(false);
    expect(drifts).toEqual([]);
  });

  it("is never cached: nothing lands in the cache, and an invalidate asks the tools again", async () => {
    const r = rig(() => []);
    r.ctl.load(experience());
    await flush();
    expect(r.cache.get(graph(), undefined, { params: {} })).toBeUndefined();
    const before = r.inv.calls.length;
    r.ctl.invalidate("h");
    await flush();
    expect(r.inv.calls.length).toBeGreaterThan(before);
  });

  it("is an answer: the same question is not re-asked by a later bind", async () => {
    const { inv, ctl } = rig(() => []);
    const exp = experience();
    ctl.load(exp);
    await flush();
    const before = inv.calls.length;
    ctl.recompose(exp);
    await flush();
    expect(inv.calls.length).toBe(before);
  });

  it("empty after ready CLEARS the value — an earlier row never shows under 'no data'", async () => {
    let rows: unknown[] = [{ sku: "a" }];
    const { store, ctl } = rig(() => rows);
    ctl.load(experience());
    await flush();
    expect(store.status("h")?.state).toBe("ready");
    expect(store.value("h")).toEqual({ sku: "a", qty: 3 });
    rows = [];
    ctl.invalidate("h");
    await flush();
    expect(store.status("h")?.state).toBe("empty");
    expect(store.value("h")).toBeUndefined();
    expect(Object.hasOwn(store.state().values, "h")).toBe(false);
  });
});

describe("empty beside a proceeded input drift", () => {
  it("publishes empty; the drift (the upstream's, not the emptiness) is still reported, as proceeded", async () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp" });
    const drifts: DriftReport[] = [];
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      if (i.toolName === "db.top" && i.expectedSchemaHash !== "v2")
        throw new TypedFailure("schemaDrift", {
          toolName: i.toolName,
          expectedSchemaHash: i.expectedSchemaHash,
          observedHash: "v2",
        });
      return i.toolName === "db.top" ? { rows: [] } : { ok: 1 };
    });
    const ctl = new HydrationController({
      contentRefArgs: "none" as const,
      invoker: inv,
      store,
      setTimer: new ManualClock().setTimer,
      inputDrift: "report-and-proceed",
      onDrift: (d) => drifts.push(d),
    });
    ctl.load(experience());
    await flush();
    expect(store.status("h")?.state).toBe("empty");
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.proceeded).toBe(true);
    expect(drifts[0]?.drift.map((d) => d.kind)).toEqual(["input"]);
  });
});

describe("the hydration projection — 1.1.0 folds empty as 'no value'", () => {
  it("is version 1.1.0: publishing `empty` changed what `values` means", () => {
    expect(HYDRATION_PROJECTION_VERSION).toBe("1.1.0");
  });
  it("an empty status drops the handle's value, whether published as a status or beside a value", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    const finding = { code: "upstream-empty", severity: "warn" as const, message: "none" };
    store.setValue("h", 1, { state: "ready" });
    store.setStatus("h", { state: "empty", finding });
    expect(Object.hasOwn(store.state().values, "h")).toBe(false);
    store.setValue("h", 2, { state: "empty", finding });
    expect(Object.hasOwn(store.state().values, "h")).toBe(false);
    expect(store.status("h")?.state).toBe("empty");
  });
});
