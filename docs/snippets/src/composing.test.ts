// The code of docs/guides/composing.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { boardExperience, catalog } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  type Experience,
  type Operation,
  apply,
  applyAt,
  experienceNodeIds,
  keyConflicts,
  mergeExperiences,
  preservesNodes,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
// #endregion imports

describe("docs/guides/composing.md", () => {
  const base: Experience = boardExperience();

  it("refuses with a typed finding instead of throwing", () => {
    // #region refusal
    const r = apply(base, { type: "removeNode", nodeId: "root" });
    if (!r.ok) console.log(r.finding.code); // "root-immutable"
    // #endregion refusal
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.code).toBe("root-immutable");
  });

  it("revises in place without losing identity", () => {
    // #region revise
    const ops: Operation[] = [
      { type: "setProps", nodeId: "p99", patch: { unit: "s" } },
      { type: "setLabel", nodeId: "p99", label: { key: "latency.p99", fallback: "p99, seconds" } },
      { type: "setPlacement", nodeId: "p99", span: 12 },
    ];
    const revised = replay(base, ops);
    if (!revised.ok) throw new Error(revised.finding.message);

    // Same ids before and after: the widget keeps its element, focus and subscriptions.
    const identity = preservesNodes(experienceNodeIds(base), experienceNodeIds(revised.value));
    // identity.ok === true, identity.added === []
    // #endregion revise
    expect(identity.ok).toBe(true);
    expect(identity.added).toEqual([]);
    expect(base.versionHash).not.toBe(seal(revised.value).versionHash);
  });

  it("detects a stale author with applyAt", () => {
    // #region stale
    const moved = replay(base, [{ type: "setProps", nodeId: "p99", patch: { unit: "s" } }]);
    if (!moved.ok) throw new Error(moved.finding.message);
    const head = seal(moved.value);

    // This author composed against `base`, but the line has moved on to `head`.
    const stale = applyAt(
      head,
      { type: "setProps", nodeId: "p99", patch: { unit: "ms" } },
      { baseVersion: base.versionHash }
    );
    if (!stale.ok) console.log(stale.finding.code); // "stale-base-version"
    // #endregion stale
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.finding.code).toBe("stale-base-version");
  });

  it("merges two forks and reports what it could not decide", () => {
    // #region merge
    const fork = (op: Operation): Experience => {
      const r = apply(base, op);
      if (!r.ok) throw new Error(r.finding.message);
      return seal(r.value);
    };
    const ana = fork({ type: "setLabel", nodeId: "p99", label: { key: "l", fallback: "p99" } });
    const ben = fork({ type: "setLabel", nodeId: "p99", label: { key: "l", fallback: "P99!" } });

    const { experience, conflicts } = mergeExperiences(base, ana, ben);
    // Ours wins every conflict; the merge is unsealed and has no parents yet.
    const merged = seal({ ...experience, parents: [ana.versionHash, ben.versionHash] });

    // conflicts: [{ plane: "layout", kind: "edit/edit", ref: "p99", detail: "..." }]
    const keys = keyConflicts(ana.root, ben.root, merged.root); // the localization check alone
    // #endregion merge
    expect(conflicts.map((c) => `${c.plane}:${c.kind}:${c.ref}`)).toEqual(["layout:edit/edit:p99"]);
    expect(merged.parents).toEqual([ana.versionHash, ben.versionHash]);
    expect(Array.isArray(keys)).toBe(true);
  });

  it("validates an experience against a catalogue", () => {
    // #region validate
    const v = validateExperience(base, catalog, "terminal");
    const errors = v.findings.filter((f) => f.severity === "error");
    // errors === [], v.nodes === 1
    // #endregion validate
    expect(errors).toEqual([]);
    expect(v.nodes).toBe(1);
  });

  it("keeps docs/guides/composing.md in step with this file", () => {
    expectDocMirrors("docs/guides/composing.md", "composing.test.ts");
  });
});
