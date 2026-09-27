import { createHash } from "node:crypto";
import {
  type ContainerNode,
  type Experience,
  type Finding,
  type ProviderSpec,
  genesis,
} from "@loom-ui/core";
import { isTainted, unwrapTainted } from "@loom/classify";
import { EffectRuntime } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import {
  SANDBOX_TOOL_ID,
  type SandboxLimits,
  type ScriptReader,
  registerSandboxEval,
} from "@loom/plugin-sandbox";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type DriftReport, HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { executeProvider } from "./provider";
import { serveHandle } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// G11 against loom's REAL sandbox: the reshaping script runs in QuickJS through a real
// `EffectRuntime` (`invokeTransient`), so the channel a crashing script completes on is loom's
// own `scriptError` — not a fake's choice. Only the MCP tool is faked.

const RAW = { rows: [{ cell: "RAW-CELL" }] };
const SCRIPT_TEXT = "SCRIPT-AUTHORED-TEXT";

const address = (code: string): string =>
  `sha256:${createHash("sha256").update(code).digest("hex")}`;

/** Content-addressed scripts; `tamper` serves bytes that do not match their address. */
function scripts(codes: readonly string[], tamper = false): ScriptReader {
  const byRef = new Map(codes.map((c) => [address(c), new TextEncoder().encode(c)]));
  return {
    get: async (ref) => {
      const bytes = byRef.get(ref.__loomContent);
      if (bytes === undefined) return null;
      return tamper ? new TextEncoder().encode("0") : bytes;
    },
  };
}

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((e) => e.close()));
});

/** The MCP tool faked; the sandbox is loom's real effect behind a real `EffectRuntime`. */
function invoker(
  reader: ScriptReader,
  limits: SandboxLimits = {},
  raw: unknown = RAW
): FakeInvoker {
  const effects = new EffectRuntime();
  opened.push(registerSandboxEval(effects, reader, { limits }));
  return new FakeInvoker()
    .on(MCP_INVOKE_TOOL_ID, () => raw)
    .on(SANDBOX_TOOL_ID, (input, opts) => effects.invokeTransient(SANDBOX_TOOL_ID, input, opts));
}

const spec = (code: string): ProviderSpec =>
  providerSpec("h", [mcpStep("s1", "t")], {
    reshaping: { engine: "QuickJS", scriptRef: address(code) },
  });

describe("a failed reshaping through loom's real sandbox (G11)", () => {
  it("a script that throws on the output is output drift with the script-error kind and a tainted sample", async () => {
    const code = `throw new TypeError("${SCRIPT_TEXT} " + input.rows.length)`;
    const r = await executeProvider(spec(code), {
      invoker: invoker(scripts([code])),
      captureSample: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("reshape-scriptError");
    expect(r.drift).toHaveLength(1);
    const d = r.drift[0];
    expect(d).toMatchObject({
      kind: "output",
      handle: "h",
      stepId: "s1",
      reshapeFailure: "reshape-scriptError",
      reshapeFailureKind: "script-error",
    });
    // The raw output travels only as a tainted sample; the script's own text never enters the
    // drift record (it is untrusted, and only the failure's code is carried).
    expect(isTainted(d?.observedSample)).toBe(true);
    expect(unwrapTainted(d?.observedSample)).toEqual(RAW);
    const { observedSample: _sample, ...rest } = d ?? {};
    expect(JSON.stringify(rest)).not.toContain(SCRIPT_TEXT);
  });

  it("a syntax error in the script is the script's own fault too", async () => {
    const code = "(() => { return input.; })()";
    const r = await executeProvider(spec(code), { invoker: invoker(scripts([code])) });
    expect(!r.ok && r.drift.map((d) => d.reshapeFailureKind)).toEqual(["script-error"]);
  });

  it("a wallClock kill is NOT drift (host-load dependent)", async () => {
    const code = "while (true) {}";
    const r = await executeProvider(spec(code), {
      invoker: invoker(scripts([code]), {
        interruptBudget: Number.MAX_SAFE_INTEGER,
        wallClockMs: 50,
      }),
    });
    expect(!r.ok && r.finding.code).toBe("reshape-limitExceeded");
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("a cpu kill IS drift (deterministic on this input)", async () => {
    const code = "while (true) {}";
    const r = await executeProvider(spec(code), {
      invoker: invoker(scripts([code]), { interruptBudget: 50, wallClockMs: 60_000 }),
    });
    expect(!r.ok && r.drift.map((d) => d.reshapeFailureKind)).toEqual(["limit-cpu"]);
  });

  it("an infrastructure failure (script bytes fail their content address) is NOT drift", async () => {
    const code = "input";
    const r = await executeProvider(spec(code), { invoker: invoker(scripts([code], true)) });
    expect(!r.ok && r.finding.code).toBe("reshape-failed");
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("a missing script is NOT drift", async () => {
    const r = await executeProvider(spec("input"), { invoker: invoker(scripts([])) });
    expect(!r.ok && r.finding.code).toBe("reshape-scriptMissing");
    expect(!r.ok && r.drift).toEqual([]);
  });
});

describe("a script error's text never rides a finding (G11)", () => {
  // The script ECHOES the raw output in what it throws — script-authored text can carry any
  // (possibly sensitive, untrusted) output value. It must appear ONLY inside the tainted sample.
  const MARKER = "ECHOED-OUTPUT-MARKER-7731";
  const raw = { rows: [{ cell: MARKER }] };
  const code = "throw new Error(input.rows[0].cell)";
  const inv = () => invoker(scripts([code]), {}, raw);
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
      providers: { h: spec(code) },
    };
  };
  const withoutSamples = (reports: readonly DriftReport[]) =>
    reports.map((r) => ({
      ...r,
      drift: r.drift.map(({ observedSample: _s, ...d }) => d),
    }));

  it("executeProvider: the finding names the kind in fixed text; the marker is only in the tainted sample", async () => {
    const r = await executeProvider(spec(code), { invoker: inv(), captureSample: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("reshape-scriptError");
    expect(r.finding.message).toContain("script-error");
    expect(JSON.stringify([r.finding, r.findings])).not.toContain(MARKER);
    const [d] = r.drift;
    expect(unwrapTainted(d?.observedSample)).toEqual(raw);
    const { observedSample: _s, ...rest } = d ?? {};
    expect(JSON.stringify(rest)).not.toContain(MARKER);
  });

  it("in-process status, onDrift, onFinding and the split public finding never carry it", async () => {
    const e = exp();
    const local: DriftReport[] = [];
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    const loaded = new HydrationController({
      invoker: inv(),
      store,
      clock: () => 0,
      setTimer: new ManualClock().setTimer,
      captureSample: true,
      onDrift: (r) => local.push(r),
    }).load(e);
    await flush();
    const status = store.state().status.h;
    expect(status?.state).toBe("error");
    expect(status?.finding?.code).toBe("reshape-scriptError");
    expect(JSON.stringify([store.state(), loaded])).not.toContain(MARKER);
    expect(local).toHaveLength(1);
    expect(JSON.stringify(withoutSamples(local))).not.toContain(MARKER);

    const remote: DriftReport[] = [];
    const full: Finding[] = [];
    const served = await serveHandle(
      e,
      { experienceId: "e", versionHash: "v1", handle: "h", params: {} },
      {
        invoker: inv(),
        now: 0,
        captureSample: true,
        onDrift: (r) => remote.push(r),
        onFinding: (_h, f) => full.push(f),
      }
    );
    expect(served.state).toBe("error");
    expect(full.map((f) => f.code)).toContain("reshape-scriptError");
    expect(JSON.stringify([served, full])).not.toContain(MARKER);
    expect(remote).toHaveLength(1);
    expect(JSON.stringify(withoutSamples(remote))).not.toContain(MARKER);
    // …and the sample is where it still is, tainted.
    const sample = remote[0]?.drift[0]?.observedSample;
    expect(isTainted(sample)).toBe(true);
    expect(JSON.stringify(unwrapTainted(sample))).toContain(MARKER);
  });
});
