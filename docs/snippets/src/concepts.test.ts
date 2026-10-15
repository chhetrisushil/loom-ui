// The code of docs/user-guide.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { catalog, meta } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import { type Operation, compile, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration/client";
// #endregion imports

describe("docs/user-guide.md", () => {
  it("replays deterministically and addresses content", () => {
    // #region address
    const ops: Operation[] = [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "note",
          order: "V",
          kind: "semantic",
          type: "Metric",
          typeVersion: "1.0.0",
          span: 6,
          props: { unit: "ms" },
          binding: { handle: "latency", priority: "P0" },
        },
      },
    ];
    const start = () =>
      genesis({ experienceId: "demo", intent: { objective: "Demo", source: "user" }, meta });

    const a = replay(start(), ops);
    const b = replay(start(), ops);
    if (!a.ok || !b.ok) throw new Error("replay refused");

    // Same operations, same content address, on any machine, in any order of construction.
    seal(a.value).versionHash === seal(b.value).versionHash; // true

    // A compile never throws on a bad experience: the problems are findings. Here the binding
    // names a handle with no provider.
    const { findings, ok } = compile(seal(a.value), {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    findings.map((f) => `${f.severity} ${f.code} ${f.nodeId}`); // ["warn unknown-handle note"]
    // #endregion address
    expect(seal(a.value).versionHash).toBe(seal(b.value).versionHash);
    expect(seal(a.value).versionHash).toMatch(/^sha256:|^[0-9a-f]{16,}/);
    expect(findings.map((f) => `${f.severity} ${f.code} ${f.nodeId}`)).toEqual([
      "warn unknown-handle note",
    ]);
    expect(ok).toBe(true);
  });

  it("keeps docs/user-guide.md in step with this file", () => {
    expectDocMirrors("docs/user-guide.md", "concepts.test.ts");
  });
});
