import {
  type ContainerNode,
  type Experience,
  type MCPToolNode,
  type ProviderSpec,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DriftReport, HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import type { HandleLoadResult } from "./scheduler";
import {
  type HandleInventory,
  type HandleLoadRequest,
  type HandleLoader,
  SplitHydrationController,
  handleInventory,
  serveHandle,
  serveHandles,
} from "./split";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

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
const boundary = (exp: Experience, inv: FakeInvoker, drifts: DriftReport[] = []) => {
  const requests: HandleLoadRequest[] = [];
  const batches: string[][] = [];
  const serveOpts = {
    invoker: inv,
    now: NOW,
    outputKinds,
    onDrift: (r: DriftReport) => drifts.push(r),
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

const splitRig = (exp: Experience, inv: FakeInvoker = toolServer()) => {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: exp.experienceId,
  });
  const { loader, requests, batches } = boundary(exp, inv);
  const ctl = new SplitHydrationController({ loader, store, setTimer: clock.setTimer });
  return { clock, store, ctl, requests, batches, inv };
};

describe("handleInventory", () => {
  it("lists handle, priority and overridable param names — and nothing of the provider", () => {
    const { inventory, findings } = handleInventory(board());
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
    const a = handleInventory(board()).inventory.handles;
    const b = handleInventory(board()).inventory.handles;
    const c = handleInventory(
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
    const { inventory, findings } = handleInventory({ ...exp, providers: rest });
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
    expect(ctl.load(handleInventory(exp).inventory).findings).toEqual([]);
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
    ctl.load(handleInventory(exp).inventory);
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
    const r = ctl.load(handleInventory(broken).inventory);
    expect(r.findings.map((f) => f.code)).toEqual(["unknown-handle"]);
    await flush();
    expect(store.status("archive")?.state).toBe("error");
    expect(requests.map((q) => q.handle)).not.toContain("archive");
  });

  it("a loader that throws, or answers with something that is not a load result, is an error status", async () => {
    const exp = board();
    const inventory: HandleInventory = handleInventory(exp).inventory;
    for (const [answer, code] of [
      [() => Promise.reject(new Error("offline")), "load-failed"],
      [() => Promise.resolve({ state: "ready?" }), "load-malformed"],
      [() => Promise.resolve({ state: "error", finding: "nope" }), "load-malformed"],
    ] as const) {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "board" });
      const loader = { load: answer } as unknown as HandleLoader;
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
    const inventory = handleInventory(exp).inventory;
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
    split.ctl.load(handleInventory(exp).inventory);
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
    const { inventory } = handleInventory(board());
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
    ctl.load(handleInventory(exp).inventory);
    clock.advance(50);
    await flush();
    expect(batches).toEqual([["first", "second", "third"]]);
    expect(toolsCalled(inv)).toEqual(["feed"]);
    expect(store.value("third")).toBe(1);
    expect(store.value("second")).toEqual(["day", "n"]);
  });

  it("a loader without loadMany loads the group one request at a time", async () => {
    const exp = pair();
    const inv = feedServer();
    const { loader, requests } = boundary(exp, inv);
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "pair" });
    const clock = new ManualClock();
    const ctl = new SplitHydrationController({
      loader: { load: loader.load },
      store,
      setTimer: clock.setTimer,
    });
    ctl.load(handleInventory(exp).inventory);
    clock.advance(50);
    await flush();
    expect(requests.map((r) => r.handle)).toEqual(["first", "second", "third"]);
    expect(["first", "second", "third"].map((h) => store.status(h)?.state)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("a loadMany that rejects, or answers the wrong number of results, errors every member", async () => {
    const exp = pair();
    const inventory = handleInventory(exp).inventory;
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
    const inventory = handleInventory(exp).inventory;
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
    ctl.load(handleInventory(exp).inventory);
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
    const inventory = handleInventory(exp).inventory;
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
    const inventory = handleInventory(exp).inventory;
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
