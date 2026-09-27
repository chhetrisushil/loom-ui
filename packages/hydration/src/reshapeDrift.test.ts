import { type ContainerNode, type Experience, type ProviderSpec, genesis } from "@loom-ui/core";
import { isTainted, unwrapTainted } from "@loom/classify";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { SANDBOX_ERRORS, SANDBOX_TOOL_ID } from "@loom/plugin-sandbox";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { type DriftReport, HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { type DriftRecord, executeProvider, outcomeResult } from "./provider";
import { remapOperation } from "./repair";
import { defineReshapers } from "./reshape";
import { serveHandle } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// G11 — a reshaping that FAILS on the tool's output is output drift a planner can repair: the
// record carries the raw output's shape and (under `captureSample`) its tainted sample, so it
// reaches `observedSamples` / `driftContext` like a failed pin. The handle's status and every
// public finding are unchanged.

const RAW = { rows: [{ secretCell: "RAW-SECRET-412" }] };
const tool = () => new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => RAW);
/** loom's own channels, typed against `SANDBOX_ERRORS`: a channel loom drops fails to compile. */
const SCRIPT_ERROR: keyof typeof SANDBOX_ERRORS = "scriptError";
const crashing = (channel = "limitExceeded") =>
  tool().on(SANDBOX_TOOL_ID, () => {
    throw new TypedFailure(channel, { kind: "cpu" });
  });
const scripted = (over: Partial<ProviderSpec> = {}): ProviderSpec =>
  providerSpec("h", [mcpStep("s1", "t")], {
    reshaping: { engine: "QuickJS", scriptRef: "sha256:script" },
    outputShapeHash: "pinned",
    ...over,
  });

describe("a failed reshaping is output drift (G11)", () => {
  it("a sandbox failure records one output drift with the raw shape, the step and a tainted raw sample", async () => {
    const r = await executeProvider(scripted(), { invoker: crashing(), captureSample: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("reshape-limitExceeded");
    expect(r.drift).toHaveLength(1);
    const d = r.drift[0] as DriftRecord;
    expect(d).toMatchObject({
      kind: "output",
      handle: "h",
      stepId: "s1",
      expected: "reshape",
      observed: "reshape-limitExceeded",
      reshapeFailure: "reshape-limitExceeded",
      reshapeFailureKind: "limit-cpu",
      observedRawShape: { rows: [{ secretCell: "string" }] },
    });
    expect(d.observedShape).toBeUndefined();
    expect(isTainted(d.observedSample)).toBe(true);
    expect(unwrapTainted(d.observedSample)).toEqual(RAW);
  });

  it("no sample without captureSample; the shape still travels", async () => {
    const r = await executeProvider(scripted(), { invoker: crashing() });
    const d = !r.ok ? r.drift[0] : undefined;
    expect(d?.reshapeFailure).toBe("reshape-limitExceeded");
    expect(d?.observedSample).toBeUndefined();
    expect(d?.observedRawShape).toBeDefined();
  });

  const kindOf = async (spec: ProviderSpec, inv: FakeInvoker, extra = {}) => {
    const r = await executeProvider(spec, { invoker: inv, ...extra });
    expect(r.ok).toBe(false);
    return !r.ok ? r.drift.map((d) => [d.reshapeFailureKind, d.reshapeFailure]) : [];
  };
  const throwing = (channel: string, payload: unknown) =>
    tool().on(SANDBOX_TOOL_ID, () => {
      throw new TypedFailure(channel, payload);
    });

  it("each output-caused failure records its typed kind", async () => {
    expect(
      await kindOf(
        scripted(),
        throwing(
          SCRIPT_ERROR,
          SANDBOX_ERRORS.scriptError.parse({ name: "TypeError", message: "x" })
        )
      )
    ).toEqual([["script-error", "reshape-scriptError"]]);
    for (const k of ["cpu", "memory", "output"] as const)
      expect(await kindOf(scripted(), throwing("limitExceeded", { kind: k }))).toEqual([
        [`limit-${k}`, "reshape-limitExceeded"],
      ]);
    expect(
      await kindOf(
        scripted({ reshaping: { engine: "JSONPath", scriptRef: "totals.count" } }),
        tool()
      )
    ).toEqual([["selects-nothing", "reshape-failed"]]);
  });

  it("a Named reshaper's throw is NOT drift: host code failing is not proven output-caused", async () => {
    // A host bug or the reshaper's own I/O would otherwise get the host's reshaper replaced by a
    // model-authored binding. It stays a plain error finding, exactly as before G11.
    const r = await executeProvider(
      scripted({ reshaping: { engine: "Named", scriptRef: "boom" } }),
      {
        invoker: tool(),
        captureSample: true,
        reshapers: defineReshapers({
          boom: () => {
            throw new Error("x");
          },
        }),
      }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("reshape-failed");
    expect(r.drift).toEqual([]);
  });

  it("an output a Named reshaper cannot be handed (uncloneable) IS drift, unsampled", async () => {
    // The OUTPUT itself is the cause: it holds a value `structuredClone` cannot copy, so the
    // reshaper never runs. No sample is captured — a value that cannot be cloned is not a data
    // observation a planner can author against (and a live reference would let the planner side
    // see later mutations) — so the record carries only the codes (and a raw shape, when one
    // can be taken).
    const odd = { rows: [{ n: 1 }], hook: () => 1 };
    let ran = false;
    const r = await executeProvider(scripted({ reshaping: { engine: "Named", scriptRef: "ok" } }), {
      invoker: new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => odd),
      captureSample: true,
      reshapers: defineReshapers({
        ok: () => {
          ran = true;
          return 1;
        },
      }),
    });
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("reshape-failed");
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toMatchObject({
      kind: "output",
      handle: "h",
      stepId: "s1",
      expected: "reshape",
      reshapeFailure: "reshape-failed",
      reshapeFailureKind: "uncloneable-output",
    });
    expect(r.drift[0]?.observedSample).toBeUndefined();
  });

  it("is NOT recorded for infrastructure or transient failures: untyped throws, wallClock, denials, a missing script or reshaper, other channels, an abort", async () => {
    const plain = (e: unknown) =>
      tool().on(SANDBOX_TOOL_ID, () => {
        throw e;
      });
    class DeniedError extends Error {}
    const cases: Array<[ProviderSpec, FakeInvoker, object?]> = [
      // An untyped throw: a transport error, an unavailable worker pool — or a script error the
      // sandbox did not type. Never classified from its message.
      [scripted(), plain(new Error("sandbox script failed: TypeError"))],
      [scripted(), plain(new Error("sandbox worker pool unavailable"))],
      [scripted(), plain(new DeniedError("Capability denied"))],
      [scripted(), throwing("limitExceeded", { kind: "wallClock" })],
      [scripted(), throwing("limitExceeded", {})],
      [scripted(), throwing("scriptMissing", { ref: "sha256:script" })],
      [scripted(), throwing("shapeMismatch", { expected: "a", observed: "b" })],
      [scripted(), throwing("quotaExceeded", {})],
      [
        scripted({ reshaping: { engine: "Named", scriptRef: "nope" } }),
        tool(),
        { reshapers: defineReshapers({}) },
      ],
    ];
    for (const [spec, inv, extra] of cases) expect(await kindOf(spec, inv, extra)).toEqual([]);
    const ac = new AbortController();
    const aborting = tool().on(SANDBOX_TOOL_ID, () => {
      ac.abort();
      throw new TypedFailure("limitExceeded", { kind: "cpu" });
    });
    expect(await kindOf(scripted(), aborting, { signal: ac.signal })).toEqual([]);
  });

  it("several terminals: no stepId (the raw sample is a stepId-keyed record)", async () => {
    const r = await executeProvider(
      providerSpec("h", [mcpStep("a", "t"), mcpStep("b", "t")], {
        reshaping: { engine: "QuickJS", scriptRef: "sha256:script" },
      }),
      { invoker: crashing(), captureSample: true }
    );
    const d = !r.ok ? r.drift[0] : undefined;
    expect(d?.stepId).toBeUndefined();
    expect(unwrapTainted(d?.observedSample)).toEqual({ a: RAW, b: RAW });
  });

  it("the handle stays `error` (as before); a proceeded input drift beside it still makes it `stale`", async () => {
    const r = await executeProvider(scripted(), { invoker: crashing() });
    expect(outcomeResult(r)).toMatchObject({
      state: "error",
      finding: { code: "reshape-limitExceeded" },
    });
    const proceeded = crashing().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as { expectedSchemaHash: string; toolName: string };
      if (i.expectedSchemaHash !== "v2")
        throw new TypedFailure("schemaDrift", {
          toolName: i.toolName,
          expectedSchemaHash: i.expectedSchemaHash,
          observedHash: "v2",
        });
      return RAW;
    });
    const both = await executeProvider(scripted(), {
      invoker: proceeded,
      inputDrift: "report-and-proceed",
    });
    expect(!both.ok && both.drift.map((d) => d.kind)).toEqual(["input", "output"]);
    expect(outcomeResult(both).state).toBe("stale");
  });

  it("remapOperation refuses it: a failed reshaping needs the planner, not a pin move", async () => {
    const r = await executeProvider(scripted(), { invoker: crashing() });
    const op = remapOperation(scripted(), !r.ok ? r.drift : []);
    expect(!op.ok && op.finding.code).toBe("repair-needs-planner");
  });
});

describe("a failed reshaping: split and in-process report the same drift (G11)", () => {
  const exp = (): Experience => {
    const g = genesis({
      experienceId: "e",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      versionHash: "v1",
      root: {
        ...(g.root as ContainerNode),
        children: [
          {
            id: "n",
            order: "n",
            kind: "semantic",
            type: "Reading",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "h", priority: "P0" },
          },
        ],
      },
      providers: { h: scripted() },
    };
  };

  const both = async (inv: () => FakeInvoker) => {
    const e = exp();
    const local: DriftReport[] = [];
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    new HydrationController({
      invoker: inv(),
      store,
      clock: () => 0,
      setTimer: new ManualClock().setTimer,
      captureSample: true,
      onDrift: (r) => local.push(r),
    }).load(e);
    await flush();
    const remote: DriftReport[] = [];
    const served = await serveHandle(
      e,
      { experienceId: "e", versionHash: "v1", handle: "h", params: {} },
      { invoker: inv(), now: 0, captureSample: true, onDrift: (r) => remote.push(r) }
    );
    return { local, remote, served, status: store.state().status.h };
  };

  it("an infrastructure or transient failure fires onDrift in NEITHER, and is the same error either way", async () => {
    const infra = [
      () =>
        tool().on(SANDBOX_TOOL_ID, () => {
          throw new TypedFailure("limitExceeded", { kind: "wallClock" });
        }),
      () =>
        tool().on(SANDBOX_TOOL_ID, () => {
          throw new Error("sandbox worker pool unavailable");
        }),
    ];
    for (const inv of infra) {
      const r = await both(inv);
      expect(r.local).toEqual([]);
      expect(r.remote).toEqual([]);
      expect(r.served.state).toBe("error");
      expect(r.status?.state).toBe("error");
      expect(r.served.finding?.code).toBe(r.status?.finding?.code);
    }
  });

  it("same state, same public-or-full finding code, same drift records — and the sample never reaches the client", async () => {
    const e = exp();
    const local: DriftReport[] = [];
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    const ctl = new HydrationController({
      invoker: crashing(),
      store,
      clock: () => 0,
      setTimer: new ManualClock().setTimer,
      captureSample: true,
      onDrift: (r) => local.push(r),
    });
    ctl.load(e);
    await flush();

    const remote: DriftReport[] = [];
    const served = await serveHandle(
      e,
      { experienceId: "e", versionHash: "v1", handle: "h", params: {} },
      { invoker: crashing(), now: 0, captureSample: true, onDrift: (r) => remote.push(r) }
    );
    const wire = JSON.stringify(served);
    expect(wire).not.toContain("RAW-SECRET-412");
    expect(wire).not.toContain("secretCell");
    // The public vocabulary is unchanged: a declared sandbox channel is served as it is.
    expect(served).toMatchObject({ state: "error", finding: { code: "reshape-limitExceeded" } });
    expect(store.state().status.h).toMatchObject({
      state: "error",
      finding: { code: "reshape-limitExceeded" },
    });
    expect(local).toHaveLength(1);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.proceeded).toBe(false);
    expect(local[0]?.proceeded).toBe(false);
    const plain = (ds: readonly DriftRecord[] | undefined) =>
      (ds ?? []).map(({ observedSample, ...rest }) => ({
        ...rest,
        sample: unwrapTainted(observedSample),
      }));
    expect(plain(remote[0]?.drift)).toEqual(plain(local[0]?.drift));
    expect(plain(local[0]?.drift)[0]?.sample).toEqual(RAW);
  });
});
