import { createHash } from "node:crypto";
import type { ProviderSpec } from "@loom-ui/core";
import { isTainted, unwrapTainted } from "@loom/classify";
import { EffectRuntime } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import {
  SANDBOX_TOOL_ID,
  type SandboxLimits,
  type ScriptReader,
  registerSandboxEval,
} from "@loom/plugin-sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { executeProvider } from "./provider";
import { FakeInvoker, mcpStep, providerSpec } from "./testing.test-support";

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
function invoker(reader: ScriptReader, limits: SandboxLimits = {}): FakeInvoker {
  const effects = new EffectRuntime();
  opened.push(registerSandboxEval(effects, reader, { limits }));
  return new FakeInvoker()
    .on(MCP_INVOKE_TOOL_ID, () => RAW)
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
