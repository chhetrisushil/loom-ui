// Server / Node: the root entry executes providers (it reaches loom's sandbox and MCP plugin).
// Browser: the client entry only. Never import the root entry into a browser bundle.
// The code of docs/guides/hydration.md (see mirror.test-support.ts).
import { describe, expect, it, vi } from "vitest";
import { boardExperience, catalog } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import { createHmac } from "node:crypto";
import { type Experience, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  DEFAULT_TIME_RANGE,
  type DriftReport,
  HydrationCache,
  HydrationController,
  type RevisionFn,
  type TransientInvoker,
  defineReshapers,
  handleInventory,
  remapOperation,
  serveHandles,
} from "@loom-ui/hydration";
import {
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration/client";
import { TypedFailure } from "@loom/core";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
// #endregion imports

/** The sealed board from the walkthrough, with its time window made overridable. */
function windowed(): Experience {
  const base = boardExperience();
  const r = replay(base, [
    {
      type: "remapProvider",
      handle: "latency-p99",
      spec: {
        handle: "latency-p99",
        executionGraph: [
          {
            stepId: "read",
            toolName: "metrics.query",
            toolVersion: "1.0.0",
            toolSchemaHash: "sha256:metrics-query-v1",
            arguments: { metric: "checkout.latency.p99", from: "$now-24h", to: "$now" },
            dependsOn: [],
            idempotent: true,
            overridable: ["from", "to"],
          },
        ],
        reshaping: { engine: "Named", scriptRef: "to-kpi" },
        outputShapeHash: "",
        outputCheck: "contract",
        cachePolicy: { ttlSeconds: 30, scope: "global" },
      },
    },
  ]);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
}

describe("docs/guides/hydration.md", () => {
  it("serves handles across a trust boundary and loads them in the client", async () => {
    const experience = windowed();
    const asked: unknown[] = [];
    const invoker: TransientInvoker = {
      async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
        asked.push((input as { args: unknown }).args);
        return { p99Ms: 412.4 } as TOut;
      },
    };
    const reshapers = defineReshapers({
      "to-kpi": (raw) => ({ value: (raw as { p99Ms: number }).p99Ms, unit: "ms" }),
    });
    const serverSecret = "a-secret-from-your-secret-manager";

    // #region server
    // The revision a client sees must be KEYED: an HMAC over a server secret. A bare hash of the
    // provider would let a client confirm a guessed provider offline.
    const revisionOf: RevisionFn = (handle, fingerprint) =>
      createHmac("sha256", serverSecret).update(`${handle}\0${fingerprint}`).digest("hex");

    // Page GET: the inventory lists handles, priorities, param NAMES and revisions. No provider.
    const { inventory } = handleInventory(experience, { revisionOf });

    // Hydrate POST: untrusted requests in, `HandleLoadResult`s out, in request order.
    const cache = new HydrationCache(Date.now);
    const serve = (requests: Parameters<typeof serveHandles>[1]) =>
      serveHandles(experience, requests, {
        invoker,
        now: Date.now(),
        contentRefArgs: "none",
        outputKinds: { catalog, surface: "web" },
        reshapers,
        cache,
      });
    // #endregion server

    // #region client
    // The transport is yours; here the two calls go straight to the server function above.
    const loader: HandleLoader = {
      load: async (request) => (await serve([request]))[0] as Awaited<ReturnType<typeof serve>>[0],
      loadMany: (requests) => serve(requests),
    };

    const store = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: inventory.experienceId,
    });
    const split = new SplitHydrationController({
      store,
      loader,
      defaultParams: DEFAULT_TIME_RANGE, // { from: "$now-24h", to: "$now" }
    });
    split.load(inventory);
    // #endregion client
    await vi.waitFor(() => expect(store.status("latency-p99")?.state).toBe("ready"));

    // #region params
    split.setParams({ from: "$now-7d" }); // a time-range picker: every handle that declares `from`
    split.setParams({ to: "$now-1h" }, { handle: "latency-p99" }); // one widget's filter
    // #endregion params
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(1));

    expect(inventory.handles.map((h) => [h.handle, h.priority, h.params])).toEqual([
      ["latency-p99", "P0", ["from", "to"]],
    ]);
    expect(JSON.stringify(inventory)).not.toContain("metrics.query");
    expect(store.value("latency-p99")).toEqual({ value: 412.4, unit: "ms" });
    const last = asked.at(-1) as { from: string; to: string };
    expect(Date.parse(last.from)).toBeLessThan(Date.now() - 6 * 86_400_000);
    expect(last.to).toMatch(/^\d{4}-\d\d-\d\dT/);
    split.dispose();
  });

  it("reports input drift and derives the repair operation", async () => {
    const experience = windowed();
    // The tool server changed its input schema: the experience's pin is now out of date.
    const moved: TransientInvoker = {
      async invokeTransient() {
        throw new TypedFailure("schemaDrift", {
          toolName: "metrics.query",
          expectedSchemaHash: "sha256:metrics-query-v1",
          observedHash: "sha256:metrics-query-v2",
        });
      },
    };
    const store = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: experience.experienceId,
    });
    // #region drift
    const reports: DriftReport[] = [];
    const controller = new HydrationController({
      invoker: moved,
      store,
      contentRefArgs: "none",
      reshapers: defineReshapers({ "to-kpi": (raw) => raw }),
      // Reported, never repaired here: hydration is read-only and writes no event.
      onDrift: (report) => reports.push(report),
    });
    controller.load(experience);
    // ... later, once `onDrift` has fired, in the durable execution that owns the experience:
    const report = reports[0];
    const repair = report && remapOperation(report.spec, report.drift);
    if (repair?.ok) console.log(repair.op); // a `remapProvider` operation with the new pin
    // #endregion drift
    await vi.waitFor(() => expect(reports.length).toBe(1));
    const again = remapOperation(reports[0]!.spec, reports[0]!.drift);
    expect(again.ok && again.op.type).toBe("remapProvider");
    expect(store.status("latency-p99")?.state).toBe("stale");
    controller.dispose();
  });

  it("keeps docs/guides/hydration.md in step with this file", () => {
    expectDocMirrors("docs/guides/hydration.md", "hydration.test.ts");
  });
});
