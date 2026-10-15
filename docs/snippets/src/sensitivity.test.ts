// The code of docs/guides/sensitivity-and-audiences.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { boardExperience, catalog } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  type Experience,
  type ProviderSpec,
  compile,
  compileFingerprint,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  handleInventory,
} from "@loom-ui/hydration";
// #endregion imports

const spec = (handle: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "read",
      toolName: "hr.payroll",
      toolVersion: "1.0.0",
      toolSchemaHash: "sha256:payroll-v1",
      arguments: { metric: handle },
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: "",
  outputCheck: "contract",
  cachePolicy: { ttlSeconds: 30, scope: "principal" },
});

describe("docs/guides/sensitivity-and-audiences.md", () => {
  // #region classified
  // The board from the walkthrough, plus a node whose data is classified "sensitive".
  const build = (base: Experience): Experience => {
    const r = replay(base, [
      { type: "remapProvider", handle: "payroll", spec: spec("payroll") },
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "payroll-total",
          order: "W",
          kind: "semantic",
          type: "Metric",
          typeVersion: "1.0.0",
          span: 6,
          props: { unit: "USD" },
          binding: { handle: "payroll", priority: "P1", sensitivity: "sensitive" },
        },
      },
    ]);
    if (!r.ok) throw new Error(r.finding.message);
    return seal(r.value);
  };
  // #endregion classified

  it("compiles one experience for different viewers and audiences", () => {
    const experience = build(boardExperience());
    const placeholderKey = "a-secret-from-your-secret-manager"; // >= 16 bytes, same on every replica
    // #region compile
    const options = {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
      placeholderKey,
    } as const;

    // No clearance: the classified node is a "Restricted" placeholder under an opaque id.
    const anyone = compile(experience, { ...options, viewer: {} });
    // A cleared viewer sees everything they may.
    const analyst = compile(experience, { ...options, viewer: { clearance: "sensitive" } });
    // A wallboard: whoever is logged in, the broadcast ceiling applies (unclassified only).
    const wall = compile(experience, {
      ...options,
      viewer: { clearance: "secret" },
      audience: "broadcast",
    });

    // SERVER-SIDE ONLY: findings name real node ids and handles.
    anyone.findings.map((f) => f.code); // ["node-restricted"]
    wall.findings.map((f) => f.code); // ["audience-withheld"]
    // #endregion compile
    expect(anyone.findings.map((f) => f.code)).toEqual(["node-restricted"]);
    expect(analyst.findings).toEqual([]);
    expect(wall.findings.map((f) => f.code)).toEqual(["audience-withheld"]);
    expect(analyst.restrictedHandles).toEqual([]);
    expect(JSON.stringify(anyone.blueprint)).not.toContain("payroll");
    expect(JSON.stringify(wall.blueprint)).toContain('"redacted":true');
    expect(JSON.stringify(wall.blueprint)).not.toContain("payroll");

    // #region boundary
    // The data boundary must agree with the screen: same viewer, same audience.
    const revisionOf = (handle: string, fingerprint: string) => `${handle}:${fingerprint.length}`; // demo only: use an HMAC
    const forWall = handleInventory(experience, {
      revisionOf,
      viewer: { clearance: "secret" },
      audience: "broadcast",
    });
    forWall.inventory.handles.map((h) => h.handle); // ["latency-p99"]: "payroll" is not even listed
    // #endregion boundary
    expect(forWall.inventory.handles.map((h) => h.handle)).toEqual(["latency-p99"]);
    const forAnalyst = handleInventory(experience, {
      revisionOf,
      viewer: { clearance: "sensitive" },
    });
    expect(forAnalyst.inventory.handles.map((h) => h.handle).sort()).toEqual([
      "latency-p99",
      "payroll",
    ]);

    // #region stamp
    // Stamp what the viewer was shown. Feed the RESULT's clearance and opaque fingerprint, not the
    // asker's, so a broadcast stamp is the same whoever asked.
    const stamp = compileFingerprint({
      clearance: wall.clearance,
      locale: "en-US",
      ...wall.fingerprint,
    });
    // #endregion stamp
    expect(typeof stamp).toBe("string");
    expect(stamp).not.toBe(
      compileFingerprint({ clearance: anyone.clearance, locale: "en-US", ...anyone.fingerprint })
    );
  });

  it("keeps docs/guides/sensitivity-and-audiences.md in step with this file", () => {
    expectDocMirrors("docs/guides/sensitivity-and-audiences.md", "sensitivity.test.ts");
  });
});
