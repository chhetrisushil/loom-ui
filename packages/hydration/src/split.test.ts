import { createHmac } from "node:crypto";
import {
  type ContainerNode,
  type Experience,
  type MCPToolNode,
  type ProviderSpec,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import type { Finding } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_ERRORS, MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { SANDBOX_ERRORS, SANDBOX_TOOL_ID } from "@loom/plugin-sandbox";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HydrationCache,
  HydrationCache as HydrationCacheImpl,
  specFingerprint,
} from "./cache";
import { type DriftReport, HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import type { HandleLoadResult } from "./scheduler";
import {
  type HandleInventory,
  type HandleLoadRequest,
  type HandleLoader,
  type ServeOptions,
  SplitHydrationController,
  handleInventory,
  publicFinding,
  serveHandle,
  serveHandles,
} from "./split";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

/** A deterministic stand-in for the server's keyed hash (production: an HMAC over a server secret). */
const keyed =
  (secret: string) =>
  (handle: string, fingerprint: string): string =>
    createHmac("sha256", secret).update(`${handle}\u0000${fingerprint}`).digest("hex");
const revisionOf = keyed("test-secret");
const inventoryOf = (exp: Experience) => handleInventory(exp, { revisionOf });

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const catalog = defineSemanticCatalog({
  id: "split.test.v1",
  entries: [
    {
      name: "Reading",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "Kpi", props: [], binding: "required" } },
    },
    {
      name: "Roster",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "Table", props: [], binding: "required" } },
    },
  ],
});
const outputKinds = { catalog, surface: "web" as const };

const widget = (
  id: string,
  type: string,
  handle: string,
  priority: "P0" | "P1" | "P2"
): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle, priority },
});
const step = (tool: string, args: Record<string, unknown>, overridable: string[]): MCPToolNode => ({
  ...mcpStep("s", tool, args),
  ...(overridable.length > 0 && { overridable }),
});
const contract = (handle: string, s: MCPToolNode, path: string): ProviderSpec =>
  providerSpec(handle, [s], {
    outputCheck: "contract",
    reshaping: { engine: "JSONPath", scriptRef: path },
  });

/** A station board: a Kpi (P0), an alert table (P1, empty today) and an archive table (P2, a null cell). */
const board = (over: Partial<Record<string, ProviderSpec>> = {}): Experience => {
  const g = genesis({
    experienceId: "board",
    intent: { objective: "watch a station", source: "user" },
    meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
  });
  const providers: Record<string, ProviderSpec> = {
    latest: contract(
      "latest",
      step("readings", { station: "ridge", from: "$now-1h" }, ["station", "from"]),
      "kpi"
    ),
    alerts: contract("alerts", step("alerts", { station: "ridge" }, ["station"]), "table"),
    archive: contract("archive", step("archive", {}, []), "table"),
  };
  for (const [h, spec] of Object.entries(over)) if (spec) providers[h] = spec;
  return {
    ...g,
    versionHash: "sha256:board-v1",
    root: {
      ...(g.root as ContainerNode),
      children: [
        widget("now", "Reading", "latest", "P0"),
        widget("log", "Roster", "alerts", "P1"),
        widget("old", "Roster", "archive", "P2"),
      ],
    },
    providers,
  };
};

const toolServer = () =>
  new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
    const i = input as McpIn;
    if (i.toolName === "readings")
      return { kpi: { value: i.args.station === "harbour" ? 14.5 : 9.25, unit: "°C" } };
    if (i.toolName === "alerts") return { table: { columns: ["at", "level"], rows: [] } };
    return {
      table: {
        columns: ["day", "max"],
        rows: [
          ["mon", 11],
          ["tue", null],
        ],
      },
    };
  });

const req = (
  exp: Experience,
  handle: string,
  params: Record<string, unknown> = {}
): HandleLoadRequest => ({
  experienceId: exp.experienceId,
  versionHash: exp.versionHash,
  handle,
  params,
});

/**
 * The trust boundary: requests and results cross as JSON, exactly as over HTTP. `load` answers one
 * request with `serveHandle`; `loadMany` answers a whole group with ONE `serveHandles` pass.
 */
const boundary = (
  exp: Experience,
  inv: FakeInvoker,
  drifts: DriftReport[] = [],
  extra: Partial<ServeOptions> = {}
) => {
  const requests: HandleLoadRequest[] = [];
  const batches: string[][] = [];
  const serveOpts: ServeOptions = {
    invoker: inv,
    now: NOW,
    outputKinds,
    onDrift: (r: DriftReport) => drifts.push(r),
    ...extra,
  };
  const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const loader: Required<HandleLoader> = {
    async load(request) {
      const w = wire(request);
      requests.push(w);
      batches.push([w.handle]);
      return wire(await serveHandle(exp, w, serveOpts));
    },
    async loadMany(many) {
      const w = wire(many);
      requests.push(...w);
      batches.push(w.map((r) => r.handle));
      return wire(await serveHandles(exp, w, serveOpts));
    },
  };
  return { loader, requests, batches };
};

const splitRig = (
  exp: Experience,
  inv: FakeInvoker = toolServer(),
  extra: Partial<ServeOptions> = {}
) => {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: exp.experienceId,
  });
  const { loader, requests, batches } = boundary(exp, inv, [], extra);
  const ctl = new SplitHydrationController({ loader, store, setTimer: clock.setTimer });
  return { clock, store, ctl, requests, batches, inv };
};

describe("handleInventory", () => {
  it("lists handle, priority and overridable param names — and nothing of the provider", () => {
    const { inventory, findings } = inventoryOf(board());
    expect(findings).toEqual([]);
    expect(inventory.experienceId).toBe("board");
    expect(inventory.versionHash).toBe("sha256:board-v1");
    expect(
      inventory.handles.map(({ handle, priority, params }) => ({ handle, priority, params }))
    ).toEqual([
      { handle: "latest", priority: "P0", params: ["from", "station"] },
      { handle: "alerts", priority: "P1", params: ["station"] },
      { handle: "archive", priority: "P2", params: [] },
    ]);
    const wire = JSON.stringify(inventory);
    for (const secret of [
      "executionGraph",
      "toolName",
      "readings",
      "scriptRef",
      "kpi",
      "$now-1h",
      "ridge",
    ])
      expect(wire).not.toContain(secret);
  });

  it("the revision moves when the provider behind a handle changes, and only then", () => {
    const a = inventoryOf(board()).inventory.handles;
    const b = inventoryOf(board()).inventory.handles;
    const c = inventoryOf(
      board({
        alerts: contract("alerts", step("alerts", { station: "ridge" }, ["station"]), "table.rows"),
      })
    ).inventory.handles;
    expect(a.map((r) => r.revision)).toEqual(b.map((r) => r.revision));
    expect(c[1]?.revision).not.toBe(a[1]?.revision);
    expect(c[0]?.revision).toBe(a[0]?.revision);
  });

  it("a bound handle with no provider is listed with its finding, so the client can show the error", () => {
    const exp = board();
    const { archive: _dropped, ...rest } = exp.providers;
    const { inventory, findings } = inventoryOf({ ...exp, providers: rest });
    expect(findings.map((f) => f.code)).toEqual(["unknown-handle"]);
    expect(inventory.handles.find((r) => r.handle === "archive")?.finding?.code).toBe(
      "unknown-handle"
    );
  });
});

describe("serveHandle", () => {
  it("runs the provider with the request's params, the server's clock and the surface's kinds", async () => {
    const exp = board();
    const inv = toolServer();
    const r = await serveHandle(exp, req(exp, "latest", { station: "harbour" }), {
      invoker: inv,
      now: NOW,
      outputKinds,
    });
    expect(r).toEqual({ state: "ready", value: { value: 14.5, unit: "°C" } });
    expect((inv.calls[0]?.input as McpIn).args).toEqual({
      station: "harbour",
      from: "2026-09-23T11:00:00.000Z",
    });
  });

  it("an empty result set is a healthy empty table, not drift", async () => {
    const exp = board();
    const drifts: DriftReport[] = [];
    const r = await serveHandle(exp, req(exp, "alerts"), {
      invoker: toolServer(),
      now: NOW,
      outputKinds,
      onDrift: (d) => drifts.push(d),
    });
    expect(r).toEqual({ state: "ready", value: { columns: ["at", "level"], rows: [] } });
    expect(drifts).toEqual([]);
  });

  it("a param the provider does not declare never reaches a tool", async () => {
    const exp = board();
    const inv = toolServer();
    await serveHandle(exp, req(exp, "alerts", { station: "harbour", colour: "red" }), {
      invoker: inv,
      now: NOW,
      outputKinds,
    });
    expect((inv.calls[0]?.input as McpIn).args).toEqual({ station: "harbour" });
  });

  it("refuses a request for another version, an unknown or reserved handle, or bad params — without a call", async () => {
    const exp = board();
    const inv = toolServer();
    const opts = { invoker: inv, now: NOW, outputKinds };
    const codes = [
      await serveHandle(exp, { ...req(exp, "latest"), versionHash: "sha256:other" }, opts),
      await serveHandle(exp, req(exp, "nope"), opts),
      await serveHandle(exp, req(exp, "__proto__"), opts),
      await serveHandle(exp, req(exp, "latest", { station: Number.NaN }), opts),
      await serveHandle(
        exp,
        { ...req(exp, "latest"), handle: 7 } as unknown as HandleLoadRequest,
        opts
      ),
    ].map((r) => (r.state === "ready" ? "ready" : r.finding.code));
    expect(codes).toEqual([
      "version-mismatch",
      "unknown-handle",
      "invalid-handle",
      "invalid-params",
      "invalid-request",
    ]);
    expect(inv.calls).toHaveLength(0);
  });

  it("an input drift is stale and reported on the head; a read-only viewer proceeds and still reports it", async () => {
    const exp = board();
    const drifting = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      if (i.expectedSchemaHash !== "v2")
        throw new TypedFailure("schemaDrift", {
          toolName: i.toolName,
          expectedSchemaHash: i.expectedSchemaHash,
          observedHash: "v2",
        });
      return { kpi: { value: 1 } };
    });
    const drifts: DriftReport[] = [];
    const head = await serveHandle(exp, req(exp, "latest"), {
      invoker: drifting,
      now: NOW,
      outputKinds,
      onDrift: (d) => drifts.push(d),
    });
    expect(head.state).toBe("stale");
    const viewer = await serveHandle(exp, req(exp, "latest"), {
      invoker: drifting,
      now: NOW,
      outputKinds,
      inputDrift: "report-and-proceed",
      onDrift: (d) => drifts.push(d),
    });
    expect(viewer).toMatchObject({
      state: "ready",
      value: { value: 1 },
      finding: { code: "schema-drift-proceeded" },
    });
    expect(drifts.map((d) => [d.handle, d.proceeded])).toEqual([
      ["latest", false],
      ["latest", true],
    ]);
  });
});

describe("SplitHydrationController", () => {
  it("P0 at once, P1 after the batch window, P2 on markVisible — every load through the loader", async () => {
    const exp = board();
    const { clock, store, ctl, requests } = splitRig(exp);
    expect(ctl.load(inventoryOf(exp).inventory).findings).toEqual([]);
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["latest"]);
    expect(store.status("alerts")?.state).toBe("pending");
    clock.advance(50);
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["latest", "alerts"]);
    expect(store.status("archive")).toBeUndefined();
    ctl.markVisible("archive");
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["latest", "alerts", "archive"]);
    expect(store.value("archive")).toEqual({
      columns: ["day", "max"],
      rows: [
        ["mon", 11],
        ["tue", null],
      ],
    });
    expect(["latest", "alerts", "archive"].map((h) => store.status(h)?.state)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("setParams re-requests only the handles that declare the param; handle-scoped params stay scoped", async () => {
    const exp = board();
    const { clock, store, ctl, requests } = splitRig(exp);
    ctl.load(inventoryOf(exp).inventory);
    await flush();
    clock.advance(50);
    await flush();
    ctl.setParams({ station: "harbour" });
    await flush();
    clock.advance(50);
    await flush();
    expect(requests.slice(2).map((r) => [r.handle, r.params])).toEqual([
      ["latest", { station: "harbour" }],
      ["alerts", { station: "harbour" }],
    ]);
    expect(store.value("latest")).toEqual({ value: 14.5, unit: "°C" });
    ctl.setParams({ from: "$now-7d" }, { handle: "latest" });
    await flush();
    expect(requests.slice(4).map((r) => [r.handle, r.params])).toEqual([
      ["latest", { from: "$now-7d", station: "harbour" }],
    ]);
  });

  it("a handle that cannot load is an error status without a request", async () => {
    const exp = board();
    const { archive: _dropped, ...rest } = exp.providers;
    const broken = { ...exp, providers: rest };
    const { store, ctl, requests } = splitRig(broken);
    const r = ctl.load(inventoryOf(broken).inventory);
    expect(r.findings.map((f) => f.code)).toEqual(["unknown-handle"]);
    await flush();
    expect(store.status("archive")?.state).toBe("error");
    expect(requests.map((q) => q.handle)).not.toContain("archive");
  });

  it("a loader that throws, or answers with something that is not a load result, is an error status", async () => {
    const exp = board();
    const inventory: HandleInventory = inventoryOf(exp).inventory;
    for (const [answer, code] of [
      [() => Promise.reject(new Error("offline")), "load-failed"],
      [() => Promise.resolve({ state: "ready?" }), "load-malformed"],
      [() => Promise.resolve({ state: "error", finding: "nope" }), "load-malformed"],
    ] as const) {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "board" });
      const loader = { load: answer, loadMany: answer } as unknown as HandleLoader;
      const ctl = new SplitHydrationController({
        loader,
        store,
        setTimer: new ManualClock().setTimer,
      });
      ctl.load(inventory);
      await flush();
      expect(store.status("latest")?.finding?.code).toBe(code);
    }
  });

  it("recompose drops handles the next inventory no longer lists; dispose is terminal", async () => {
    const exp = board();
    const { store, ctl } = splitRig(exp);
    const inventory = inventoryOf(exp).inventory;
    ctl.load(inventory);
    await flush();
    expect(store.status("latest")?.state).toBe("ready");
    ctl.recompose({
      ...inventory,
      handles: inventory.handles.filter((r) => r.handle !== "latest"),
    });
    expect(store.status("latest")).toBeUndefined();
    ctl.dispose();
    expect(ctl.load(inventory).findings.map((f) => f.code)).toEqual(["disposed"]);
  });
});

describe("split vs in-process hydration", () => {
  it("the same experience publishes the same values and states either way", async () => {
    const exp = board();
    const inProc = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "board" });
    const clockA = new ManualClock();
    const local = new HydrationController({
      invoker: toolServer(),
      store: inProc,
      clock: () => NOW,
      setTimer: clockA.setTimer,
      outputKinds,
    });
    local.load(exp);
    local.markVisible("archive");
    const split = splitRig(exp);
    split.ctl.load(inventoryOf(exp).inventory);
    split.ctl.markVisible("archive");
    await flush();
    clockA.advance(50);
    split.clock.advance(50);
    await flush();
    const states = (s: HydrationStore) =>
      Object.fromEntries(Object.entries(s.state().status).map(([h, st]) => [h, st.state]));
    expect(split.store.state().values).toEqual(inProc.state().values);
    expect(states(split.store)).toEqual(states(inProc));
    expect(states(inProc)).toEqual({ latest: "ready", alerts: "ready", archive: "ready" });
  });
});

/** Three handles over ONE upstream step: two P1 tables and a P0 reading, each reshaping differently. */
const pair = (): Experience => {
  const g = genesis({
    experienceId: "pair",
    intent: { objective: "watch a station", source: "user" },
    meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
  });
  const feed = () => mcpStep("s", "feed", { station: "ridge" });
  const shape = (handle: string, path: string) =>
    providerSpec(handle, [feed()], { reshaping: { engine: "JSONPath", scriptRef: path } });
  return {
    ...g,
    versionHash: "sha256:pair-v1",
    root: {
      ...(g.root as ContainerNode),
      children: [
        widget("a", "Roster", "first", "P1"),
        widget("b", "Roster", "second", "P1"),
        widget("c", "Reading", "third", "P1"),
      ],
    },
    providers: {
      first: shape("first", "rows"),
      second: shape("second", "columns"),
      third: shape("third", "n"),
    },
  };
};
const feedServer = () =>
  new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({
    rows: [["mon", 1]],
    columns: ["day", "n"],
    n: 1,
  }));
const toolsCalled = (inv: FakeInvoker) => inv.calls.map((c) => (c.input as McpIn).toolName);

describe("handleInventory is all a client learns", () => {
  it("each ref carries only handle, priority, param names and an opaque revision", () => {
    const { inventory } = inventoryOf(board());
    for (const ref of inventory.handles)
      expect(Object.keys(ref).sort()).toEqual(["handle", "params", "priority", "revision"]);
    expect(Object.keys(inventory).sort()).toEqual(["experienceId", "handles", "versionHash"]);
    const wire = JSON.stringify(inventory);
    for (const secret of [
      "arguments",
      "overridable",
      "reshaping",
      "JSONPath",
      "outputShapeHash",
      "cachePolicy",
      "schema-",
      "table",
    ])
      expect(wire).not.toContain(secret);
  });
});

describe("serveHandle trusts nothing in the request", () => {
  it("refuses a handle that has a provider but no bound node, without a call", async () => {
    const exp = board({ hidden: contract("hidden", step("secret", {}, []), "kpi") });
    const inv = toolServer();
    const r = await serveHandle(exp, req(exp, "hidden"), { invoker: inv, now: NOW, outputKinds });
    expect(r.state === "error" && r.finding.code).toBe("unknown-handle");
    expect(inv.calls).toHaveLength(0);
  });

  it("refuses a request whose experience is not this one", async () => {
    const exp = board();
    const r = await serveHandle(
      exp,
      { ...req(exp, "latest"), experienceId: "other" },
      {
        invoker: toolServer(),
        now: NOW,
        outputKinds,
      }
    );
    expect(r.state === "error" && r.finding.code).toBe("version-mismatch");
  });
});

describe("serveHandles: one server pass per batch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("N handles sharing an upstream step make ONE call; results come back in request order", async () => {
    const exp = pair();
    const inv = feedServer();
    const out = await serveHandles(
      exp,
      [req(exp, "third"), req(exp, "first"), req(exp, "second")],
      {
        invoker: inv,
        now: NOW,
      }
    );
    expect(toolsCalled(inv)).toEqual(["feed"]);
    expect(out.map((r) => r.state === "ready" && r.value)).toEqual([1, [["mon", 1]], ["day", "n"]]);
  });

  it("one clock read per batch: every $now in it is the same instant", async () => {
    let t = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => {
      t += 60_000;
      return t;
    });
    const exp = board();
    const inv = toolServer();
    await serveHandles(exp, [req(exp, "latest"), req(exp, "latest", { station: "harbour" })], {
      invoker: inv,
      outputKinds,
    });
    const froms = inv.calls.map((c) => (c.input as McpIn).args.from);
    expect(froms).toHaveLength(2);
    expect(froms[0]).toBe(froms[1]);
  });

  it("maxConcurrentCalls caps the calls of the whole batch", async () => {
    const exp = board();
    const release: Array<() => void> = [];
    const inv = new FakeInvoker().on(
      MCP_INVOKE_TOOL_ID,
      () =>
        new Promise((resolve) => release.push(() => resolve({ table: { columns: [], rows: [] } })))
    );
    const done = serveHandles(exp, [req(exp, "alerts"), req(exp, "archive")], {
      invoker: inv,
      now: NOW,
      outputKinds,
      maxConcurrentCalls: 1,
    });
    await flush();
    expect(inv.calls).toHaveLength(1);
    release.shift()?.();
    await flush();
    expect(inv.calls).toHaveLength(2);
    release.shift()?.();
    expect((await done).map((r) => r.state)).toEqual(["ready", "ready"]);
  });

  it("a bad entry is refused on its own; the rest of the batch still loads", async () => {
    const exp = pair();
    const inv = feedServer();
    const out = await serveHandles(exp, [req(exp, "first"), req(exp, "nope"), req(exp, "second")], {
      invoker: inv,
      now: NOW,
    });
    expect(out.map((r) => (r.state === "ready" ? "ready" : r.finding.code))).toEqual([
      "ready",
      "unknown-handle",
      "ready",
    ]);
  });

  it("a batch that is not a list, or is over the size bound, is refused without a call", async () => {
    const exp = pair();
    const inv = feedServer();
    const notList = await serveHandles(exp, { handle: "first" } as unknown as HandleLoadRequest[], {
      invoker: inv,
      now: NOW,
    });
    expect(notList.map((r) => r.state === "error" && r.finding.code)).toEqual(["invalid-request"]);
    const big = await serveHandles(exp, [req(exp, "first"), req(exp, "second")], {
      invoker: inv,
      now: NOW,
      maxBatch: 1,
    });
    expect(big.map((r) => r.state === "error" && r.finding.code)).toEqual([
      "batch-too-large",
      "batch-too-large",
    ]);
    expect(inv.calls).toHaveLength(0);
  });

  it("two principals' batches never share a call", async () => {
    const exp = pair();
    const release: Array<() => void> = [];
    const inv = new FakeInvoker().on(
      MCP_INVOKE_TOOL_ID,
      () => new Promise((resolve) => release.push(() => resolve({ rows: [], columns: [], n: 0 })))
    );
    const as = (actor: string) =>
      serveHandles(exp, [req(exp, "first")], {
        invoker: inv,
        now: NOW,
        principal: { tenant: "t", actor },
        principalId: actor,
      });
    const both = Promise.all([as("p1"), as("p2")]);
    await flush();
    expect(inv.calls.map((c) => c.opts?.principal)).toEqual([
      { tenant: "t", actor: "p1" },
      { tenant: "t", actor: "p2" },
    ]);
    for (const r of release) r();
    await both;
  });
});

describe("SplitHydrationController batches a group through loadMany", () => {
  it("a split load of N handles sharing an upstream step makes ONE upstream call", async () => {
    const exp = pair();
    const inv = feedServer();
    const { clock, store, ctl, batches } = splitRig(exp, inv);
    ctl.load(inventoryOf(exp).inventory);
    clock.advance(50);
    await flush();
    expect(batches).toEqual([["first", "second", "third"]]);
    expect(toolsCalled(inv)).toEqual(["feed"]);
    expect(store.value("third")).toBe(1);
    expect(store.value("second")).toEqual(["day", "n"]);
  });

  it("a loader without loadMany is refused at construction: call sharing is not optional", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "pair" });
    const { loader } = boundary(pair(), feedServer());
    for (const bad of [{ load: loader.load }, { loadMany: loader.loadMany }, null])
      expect(
        () => new SplitHydrationController({ loader: bad as unknown as HandleLoader, store })
      ).toThrow(TypeError);
  });

  it("a loadMany that rejects, or answers the wrong number of results, errors every member", async () => {
    const exp = pair();
    const inventory = inventoryOf(exp).inventory;
    for (const [loadMany, code] of [
      [() => Promise.reject(new Error("offline")), "load-failed"],
      [() => Promise.resolve([{ state: "ready", value: 1 }]), "load-malformed"],
      [() => Promise.resolve("nope"), "load-malformed"],
    ] as const) {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "pair" });
      const clock = new ManualClock();
      const loader = {
        load: () => Promise.reject(new Error("unused")),
        loadMany,
      } as unknown as HandleLoader;
      const ctl = new SplitHydrationController({ loader, store, setTimer: clock.setTimer });
      ctl.load(inventory);
      clock.advance(50);
      await flush();
      expect(["first", "second", "third"].map((h) => store.status(h)?.finding?.code)).toEqual([
        code,
        code,
        code,
      ]);
    }
  });

  it("the batch's signal aborts only when every member is abandoned", async () => {
    const exp = pair();
    const signals: AbortSignal[] = [];
    const loader: HandleLoader = {
      load: () => new Promise(() => {}),
      loadMany: (_requests, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    };
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "pair" });
    const clock = new ManualClock();
    const ctl = new SplitHydrationController({ loader, store, setTimer: clock.setTimer });
    const inventory = inventoryOf(exp).inventory;
    ctl.load(inventory);
    clock.advance(50);
    await flush();
    expect(signals).toHaveLength(1);
    ctl.recompose({ ...inventory, handles: inventory.handles.filter((r) => r.handle !== "first") });
    expect(signals[0]?.aborted).toBe(false);
    ctl.dispose();
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("SplitHydrationController params and inventory hygiene", () => {
  it("an unrelated param change re-requests nothing — not even a handle that ended on an error", async () => {
    const exp = board();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new Error("down");
    });
    const { clock, store, ctl, requests } = splitRig(exp, inv);
    ctl.load(inventoryOf(exp).inventory);
    clock.advance(50);
    await flush();
    expect(store.status("latest")?.state).toBe("error");
    const before = requests.length;
    ctl.setParams({ unrelated: 1 });
    clock.advance(50);
    await flush();
    expect(requests).toHaveLength(before);
    ctl.invalidate("latest");
    await flush();
    expect(requests).toHaveLength(before + 1);
  });

  it("scoped params for a handle the bound inventory does not list are forgotten at bind", async () => {
    const exp = board();
    const { clock, ctl, requests } = splitRig(exp);
    const inventory = inventoryOf(exp).inventory;
    ctl.setParams({ station: "harbour" }, { handle: "latest" });
    ctl.load({ ...inventory, handles: inventory.handles.filter((r) => r.handle !== "latest") });
    clock.advance(50);
    await flush();
    ctl.load(inventory);
    await flush();
    expect(requests.find((r) => r.handle === "latest")?.params).toEqual({});
  });

  it("an inventory that is not one is refused and the bound one is left exactly as it was", async () => {
    const exp = board();
    const { store, ctl } = splitRig(exp);
    const inventory = inventoryOf(exp).inventory;
    ctl.load(inventory);
    await flush();
    for (const bad of [
      null,
      { ...inventory, handles: "x" },
      { ...inventory, handles: [{ handle: "latest", priority: "P9", params: [], revision: "r" }] },
      { ...inventory, handles: [{ handle: "latest", priority: "P0", params: [1], revision: "r" }] },
    ])
      expect(ctl.recompose(bad as unknown as HandleInventory).findings.map((f) => f.code)).toEqual([
        "invalid-inventory",
      ]);
    expect(store.status("latest")?.state).toBe("ready");
  });
});

describe("the inventory revision is keyed on the server", () => {
  it("is never the provider's fingerprint, and a different key gives a different revision", () => {
    const exp = board();
    const refs = inventoryOf(exp).inventory.handles;
    for (const ref of refs) {
      const spec = exp.providers[ref.handle];
      if (spec === undefined) throw new Error("fixture");
      expect(ref.revision).not.toBe(specFingerprint(spec));
      expect(ref.revision).not.toContain(specFingerprint(spec));
    }
    const other = handleInventory(exp, { revisionOf: keyed("another-secret") }).inventory.handles;
    expect(other.map((r) => r.revision)).not.toEqual(refs.map((r) => r.revision));
  });

  it("revisionOf receives the handle and the fingerprint, and must return something else", () => {
    const seen: Array<[string, string]> = [];
    handleInventory(board(), {
      revisionOf: (h, fp) => {
        seen.push([h, fp]);
        return `r-${seen.length}`;
      },
    });
    expect(seen.map(([h]) => h)).toEqual(["latest", "alerts", "archive"]);
    expect(() => handleInventory(board(), { revisionOf: (_h, fp) => fp })).toThrow(TypeError);
    expect(() => handleInventory(board(), { revisionOf: () => 7 as unknown as string })).toThrow(
      TypeError
    );
    expect(() =>
      handleInventory(board(), undefined as unknown as { revisionOf: () => string })
    ).toThrow(TypeError);
  });

  it("the client schedules purely off the opaque revision", async () => {
    const exp = board();
    const { ctl, requests } = splitRig(exp);
    const inventory = inventoryOf(exp).inventory;
    ctl.load(inventory);
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["latest"]);
    ctl.recompose({ ...inventory });
    await flush();
    expect(requests).toHaveLength(1); // same revision, same params: already answered
    ctl.recompose({
      ...inventory,
      handles: inventory.handles.map((r) =>
        r.handle === "latest" ? { ...r, revision: "moved" } : r
      ),
    });
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["latest", "latest"]);
  });
});

describe("served findings are public: provider internals stay on the server", () => {
  const SECRETS = [
    "hidden.tool",
    "deep.path.nowhere",
    "schema-hidden.tool",
    "sha256:",
    "secret-arg",
    "pinned-shape",
    "exception-text",
    "sandbox-payload",
    "stepId",
  ];
  /** One P0 handle "h" over a tool whose name, argument, schema and reshaping are all secrets. */
  const one = (over: Partial<ProviderSpec> = {}): Experience => {
    const g = genesis({
      experienceId: "one",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      versionHash: "v1",
      root: { ...(g.root as ContainerNode), children: [widget("n", "Reading", "h", "P0")] },
      providers: {
        h: providerSpec(
          "h",
          [mcpStep("stepId-secret", "hidden.tool", { key: "secret-arg" })],
          over
        ),
      },
    };
  };
  const serve = async (exp: Experience, inv: FakeInvoker, extra: Partial<ServeOptions> = {}) => {
    const internal: Array<[string, Finding]> = [];
    const r = await serveHandle(exp, req(exp, "h"), {
      invoker: inv,
      now: NOW,
      onFinding: (h, f) => internal.push([h, f]),
      ...extra,
    });
    const wire = JSON.stringify(r);
    for (const secret of SECRETS) expect(wire).not.toContain(secret);
    expect(r.finding?.message).toContain('"h"');
    return { r, internal };
  };
  const answering = (fn: (input: McpIn) => unknown) =>
    new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => fn(input as McpIn));

  it("(a) a JSONPath reshape failure", async () => {
    const { r, internal } = await serve(
      one({ reshaping: { engine: "JSONPath", scriptRef: "deep.path.nowhere" } }),
      answering(() => ({ n: 1 }))
    );
    expect(r).toMatchObject({
      state: "error",
      finding: { code: "reshape-failed", severity: "error" },
    });
    expect(internal.some(([h, f]) => h === "h" && f.message.includes("deep.path.nowhere"))).toBe(
      true
    );
  });

  it("(b) a proceeded input drift", async () => {
    const { r, internal } = await serve(
      one(),
      answering((i) => {
        if (i.expectedSchemaHash !== "sha256:observed")
          throw new TypedFailure("schemaDrift", {
            toolName: i.toolName,
            expectedSchemaHash: i.expectedSchemaHash,
            observedHash: "sha256:observed",
          });
        return { n: 1 };
      }),
      { inputDrift: "report-and-proceed" }
    );
    expect(r).toMatchObject({
      state: "ready",
      value: { n: 1 },
      finding: { code: "schema-drift-proceeded", severity: "warn" },
    });
    expect(
      internal.some(
        ([, f]) => f.code === "schema-drift-proceeded" && f.message.includes("hidden.tool")
      )
    ).toBe(true);
  });

  it("(c) a sandbox reshape failure", async () => {
    const inv = answering(() => ({ n: 1 })).on(SANDBOX_TOOL_ID, () => {
      throw new TypedFailure("limitExceeded", {
        kind: "cpu",
        detail: "sandbox-payload exception-text",
      });
    });
    const { r, internal } = await serve(
      one({ reshaping: { engine: "QuickJS", scriptRef: "sha256:script" } }),
      inv
    );
    expect(r).toMatchObject({ state: "error", finding: { code: "reshape-limitExceeded" } });
    expect(internal.some(([, f]) => f.message.includes("sandbox-payload"))).toBe(true);
  });

  it("(d) an output-shape drift", async () => {
    const { r, internal } = await serve(
      one({ outputShapeHash: "pinned-shape" }),
      answering(() => ({ n: 1 }))
    );
    expect(r).toMatchObject({ state: "stale", finding: { code: "output-shape-drift" } });
    expect(internal.some(([, f]) => f.message.includes("pinned-shape"))).toBe(true);
  });

  it("(e) an internal throw", async () => {
    const cache = {
      get: () => {
        throw new Error("exception-text from hidden.tool");
      },
    } as unknown as HydrationCache;
    const { r, internal } = await serve(
      one(),
      answering(() => ({ n: 1 })),
      { cache }
    );
    expect(r).toMatchObject({ state: "error", finding: { code: "hydration-internal" } });
    expect(internal.map(([, f]) => f.message)).toEqual(["exception-text from hidden.tool"]);
  });

  it("a reshape or tool failure on a channel loom does not declare is served generically", async () => {
    const secretChannel = "hidden.tool: secret-arg=hunter2";
    const sandbox = answering(() => ({ n: 1 })).on(SANDBOX_TOOL_ID, () => {
      throw new TypedFailure(secretChannel, {});
    });
    const a = await serve(
      one({ reshaping: { engine: "QuickJS", scriptRef: "sha256:script" } }),
      sandbox
    );
    expect(a.r).toMatchObject({ state: "error", finding: { code: "reshape-failed" } });
    expect(JSON.stringify(a.r)).not.toContain("hunter2");
    expect(a.internal.some(([, f]) => f.code === `reshape-${secretChannel}`)).toBe(true);
    const tool = answering(() => {
      throw new TypedFailure(secretChannel, {});
    });
    const b = await serve(one(), tool);
    expect(b.r).toMatchObject({ state: "error" });
    expect(JSON.stringify(b.r)).not.toContain("hunter2");
    expect(b.internal.some(([, f]) => f.message.includes("hunter2"))).toBe(true);
    const known = await serve(
      one(),
      answering(() => {
        throw new TypedFailure("toolNotFound", { toolName: "hidden.tool" });
      })
    );
    expect(JSON.stringify(known.internal)).toContain("tool-toolNotFound");
  });

  it("the code of a served finding is a tool or reshape code only for loom's declared channels", () => {
    const f = (code: string) => publicFinding("h", { code, severity: "error", message: "m" }).code;
    expect(f("reshape-scriptMissing")).toBe("reshape-scriptMissing");
    expect(f("reshape-limitExceeded")).toBe("reshape-limitExceeded");
    expect(f("reshape-shapeMismatch")).toBe("reshape-shapeMismatch");
    expect(f("tool-toolNotFound")).toBe("tool-toolNotFound");
    expect(f("tool-schemaDrift")).toBe("tool-schemaDrift");
    expect(f("reshape-hunter2")).toBe("reshape-failed");
    expect(f("tool-hunter2")).toBe("tool-failed");
    expect(f("tool-__proto__")).toBe("tool-failed");
  });

  it("the declared channels are exactly the ones loom exports", () => {
    const f = (code: string) => publicFinding("h", { code, severity: "error", message: "m" }).code;
    const tool = Object.keys(MCP_INVOKE_ERRORS);
    const sandbox = Object.keys(SANDBOX_ERRORS);
    expect(tool.length).toBeGreaterThan(0);
    expect(sandbox.length).toBeGreaterThan(0);
    for (const ch of tool) expect(f(`tool-${ch}`)).toBe(`tool-${ch}`);
    for (const ch of sandbox) expect(f(`reshape-${ch}`)).toBe(`reshape-${ch}`);
    // Crossed over: a sandbox channel is not a tool channel, nor the reverse.
    for (const ch of sandbox.filter((c) => !tool.includes(c)))
      expect(f(`tool-${ch}`)).toBe("tool-failed");
    for (const ch of tool.filter((c) => !sandbox.includes(c)))
      expect(f(`reshape-${ch}`)).toBe("reshape-failed");
  });

  it("an async onFinding that rejects never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const probe = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", probe);
    try {
      const exp = one();
      const r = await serveHandle(exp, req(exp, "nope"), {
        invoker: answering(() => ({ n: 1 })),
        now: NOW,
        onFinding: async () => {
          throw new Error("async hook");
        },
      });
      expect(r.state).toBe("error");
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", probe);
    }
  });

  it("a request whose handle cannot even be read is one invalid-request; the rest are served", async () => {
    const exp = one();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("hostile getter");
        },
      }
    ) as HandleLoadRequest;
    const out = await serveHandles(exp, [hostile, req(exp, "h")], {
      invoker: answering(() => ({ n: 1 })),
      now: NOW,
    });
    expect(out.map((r) => r.state === "ready" || r.finding.code)).toEqual([
      "invalid-request",
      true,
    ]);
    expect(JSON.stringify(out)).not.toContain("hostile getter");
  });

  it("a request refusal is public too, and a throwing onFinding changes nothing", async () => {
    const exp = one();
    const r = await serveHandle(exp, req(exp, "nope"), {
      invoker: answering(() => ({ n: 1 })),
      now: NOW,
      onFinding: () => {
        throw new Error("hook");
      },
    });
    expect(r).toMatchObject({ state: "error", finding: { code: "unknown-handle" } });
  });

  it("every result the board serves passes the secret audit", async () => {
    const exp = board();
    const out = await serveHandles(
      exp,
      ["latest", "alerts", "archive"].map((h) => req(exp, h)),
      { invoker: toolServer(), now: NOW, outputKinds }
    );
    const wire = JSON.stringify(out);
    for (const secret of [
      "readings",
      'archive"',
      "scriptRef",
      "schema-",
      "ridge",
      "$now",
      "kpi",
      "table",
    ])
      expect(wire).not.toContain(secret);
  });
});

describe("minor guards", () => {
  it("revisionOf may not answer an empty revision", () => {
    expect(() => handleInventory(board(), { revisionOf: () => "" })).toThrow(TypeError);
  });

  it("maxConcurrentCalls must be a positive integer", async () => {
    const exp = pair();
    for (const maxConcurrentCalls of [Number.NaN, -1, 0, 1.5])
      await expect(
        serveHandles(exp, [req(exp, "first")], { invoker: feedServer(), maxConcurrentCalls })
      ).rejects.toThrow(TypeError);
  });

  it("maxBatch must be a positive integer", async () => {
    const exp = pair();
    for (const maxBatch of [Number.NaN, -1, 0, 1.5])
      await expect(
        serveHandles(exp, [req(exp, "first")], { invoker: feedServer(), maxBatch })
      ).rejects.toThrow(TypeError);
  });

  it("two principals served through ONE shared cache never see each other's values", async () => {
    const exp = pair();
    const spec = exp.providers.first;
    if (spec === undefined) throw new Error("fixture");
    const scoped: Experience = {
      ...exp,
      providers: {
        ...exp.providers,
        first: { ...spec, cachePolicy: { ttlSeconds: 60, scope: "principal" } },
      },
    };
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => ({
      rows: [[String((opts?.principal as { actor?: string } | undefined)?.actor)]],
    }));
    const cache = new HydrationCacheImpl(() => NOW);
    const as = async (actor: string) =>
      serveHandle(scoped, req(scoped, "first"), {
        invoker: inv,
        now: NOW,
        cache,
        principal: { tenant: "t", actor },
        principalId: actor,
      });
    expect(await as("p1")).toMatchObject({ value: [["p1"]] });
    expect(await as("p2")).toMatchObject({ value: [["p2"]] });
    expect(await as("p1")).toMatchObject({ value: [["p1"]] });
    expect(inv.calls).toHaveLength(2);
  });
});

describe("split vs in-process parity when things go wrong", () => {
  const parity = async (
    exp: Experience,
    inv: () => FakeInvoker,
    extra: Partial<ServeOptions> = {}
  ) => {
    const inProc = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: exp.experienceId,
    });
    const local = new HydrationController({
      invoker: inv(),
      store: inProc,
      clock: () => NOW,
      setTimer: new ManualClock().setTimer,
      ...(extra.inputDrift !== undefined && { inputDrift: extra.inputDrift }),
    });
    local.load(exp);
    const split = splitRig(exp, inv(), extra);
    split.ctl.load(inventoryOf(exp).inventory);
    await flush();
    const view = (s: HydrationStore) =>
      Object.fromEntries(
        Object.entries(s.state().status).map(([h, st]) => [h, [st.state, st.finding?.code]])
      );
    expect(view(split.store)).toEqual(view(inProc));
    expect(split.store.state().values).toEqual(inProc.state().values);
    return view(inProc);
  };
  const single = (): Experience => {
    const g = genesis({
      experienceId: "single",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      versionHash: "v1",
      root: { ...(g.root as ContainerNode), children: [widget("n", "Reading", "h", "P0")] },
      providers: { h: providerSpec("h", [mcpStep("s", "t")]) },
    };
  };

  it("a failing tool is the same error either way", async () => {
    const view = await parity(single(), () =>
      new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
        throw new TypedFailure("toolNotFound", { toolName: "t" });
      })
    );
    expect(view.h?.[0]).toBe("error");
  });

  it("an input drift under report-and-proceed is the same ready value and warning either way", async () => {
    const view = await parity(
      single(),
      () =>
        new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
          const i = input as McpIn;
          if (i.expectedSchemaHash !== "v2")
            throw new TypedFailure("schemaDrift", {
              toolName: i.toolName,
              expectedSchemaHash: i.expectedSchemaHash,
              observedHash: "v2",
            });
          return { n: 1 };
        }),
      { inputDrift: "report-and-proceed" }
    );
    expect(view.h).toEqual(["ready", "schema-drift-proceeded"]);
  });
});
