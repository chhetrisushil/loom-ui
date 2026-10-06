import { type Provenance, type RecordedOperation, type SemanticNode, genesis } from "@loom-ui/core";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import { InMemoryLineageStore } from "./store";

const user: Provenance = { source: "user", agentId: "u1" };
const agent: Provenance = { source: "agent", modelId: "m-1", decisionId: "plan:compose:abc" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const g = (id: string) =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
const node = (id: string, handle: string, sensitivity?: "secret" | "internal"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const rec = (op: RecordedOperation["op"], by: Provenance): RecordedOperation => ({
  op,
  by,
  at: "2026-10-06T00:00:00Z",
});
const ins = (n: SemanticNode, by = user) =>
  rec({ type: "insertNode", parentId: "root", node: n }, by);

function ok<T>(r: LineageResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.refusal)}`);
  return r.value;
}
const make = () => {
  const content = new InMemoryContentStore();
  return new Lineage({ events: new InMemoryLineageStore(), content });
};
const cleared = { clearance: "secret" as const };
type Why = {
  available: true;
  created?: { by: Provenance; op: string; versionHash: string };
  changed?: { op: string };
  why?: { text: string };
  prompt?: { text: string };
  changes: number;
};
const asAvail = (r: unknown) => r as Why;

describe("Lineage provenance and explain (U12)", () => {
  it("links a node to the version, the op and the decision that created it, and what changed it", async () => {
    const lin = make();
    const v1 = ok(await lin.start(g("e"), user));
    const v2 = ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        ops: [
          rec(
            {
              type: "prompt",
              text: "show latency",
              materialized: [{ type: "insertNode", parentId: "root", node: node("a", "h") }],
            },
            agent
          ),
        ],
        by: agent,
        summary: "Added a latency card.",
      })
    );
    const v3 = ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v2.experience.versionHash,
        ops: [rec({ type: "setProps", nodeId: "a", patch: { unit: "ms" } }, user)],
        by: user,
      })
    );
    const e = asAvail(ok(await lin.explain("e", "a", { viewer: cleared })));
    expect(e.created).toMatchObject({
      op: "insertNode",
      versionHash: v2.experience.versionHash,
      by: { decisionId: "plan:compose:abc", modelId: "m-1" },
    });
    expect(e.changed).toMatchObject({ op: "setProps" });
    expect(e.changes).toBe(1);
    expect(e.why?.text).toBe("Added a latency card.");
    expect(e.prompt?.text).toBe("show latency");
    // the version 'as it was': before the edit it had no change
    const before = asAvail(
      ok(await lin.explain("e", "a", { viewer: cleared, versionHash: v2.experience.versionHash }))
    );
    expect(before.changes).toBe(0);
    expect(v3.experience.versionHash).not.toBe(v2.experience.versionHash);
  });

  it("a node of the genesis predates the ledger: origin is the line's start", async () => {
    const lin = make();
    const base = g("e");
    const v1 = ok(await lin.start(base, user));
    const e = ok(await lin.explain("e", "root", { viewer: cleared })) as {
      created?: { op: string; versionHash: string };
    };
    expect(e.created).toMatchObject({ op: "origin", versionHash: v1.experience.versionHash });
  });

  it("the summary is withheld from a viewer who cannot see the version's class floor", async () => {
    const lin = make();
    const v1 = ok(await lin.start(g("e"), user));
    ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"), agent), ins(node("s", "hs", "secret"), agent)],
        by: agent,
        summary: "Added a card and a secret card.",
      })
    );
    const low = asAvail(ok(await lin.explain("e", "a", { viewer: { clearance: "internal" } })));
    expect(low.created).toBeDefined();
    expect(low.why).toBeUndefined();
    expect(low.prompt).toBeUndefined();
    // and the secret node itself: bare unavailable, identical to an unknown id
    const hidden = ok(await lin.explain("e", "s", { viewer: { clearance: "internal" } }));
    const unknown = ok(await lin.explain("e", "ghost", { viewer: { clearance: "internal" } }));
    expect(hidden).toEqual({ available: false });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(unknown));
    expect(asAvail(ok(await lin.explain("e", "a", { viewer: cleared }))).why?.text).toContain(
      "secret card"
    );
  });

  it("a summaryClass stamped above the viewer withholds the words even when the floor is clean", async () => {
    const lin = make();
    const v1 = ok(await lin.start(g("e"), user));
    ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"), agent)],
        by: agent,
        summary: "From classified samples.",
        summaryClass: "secret",
      })
    );
    expect(
      asAvail(ok(await lin.explain("e", "a", { viewer: { clearance: "internal" } }))).why
    ).toBeUndefined();
    expect(asAvail(ok(await lin.explain("e", "a", { viewer: cleared }))).why).toBeDefined();
  });

  it("a revert has the provenance of the version it restores; later edits layer on top", async () => {
    const lin = make();
    const v1 = ok(await lin.start(g("e"), user));
    const v2 = ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"), agent)],
        by: agent,
      })
    );
    const v3 = ok(
      await lin.compose({
        experienceId: "e",
        expectedHead: v2.experience.versionHash,
        ops: [rec({ type: "setProps", nodeId: "a", patch: { x: 1 } }, user)],
        by: user,
      })
    );
    const r = ok(
      await lin.revert({
        experienceId: "e",
        expectedHead: v3.experience.versionHash,
        to: v2.experience.versionHash,
        by: user,
      })
    );
    const e = asAvail(
      ok(await lin.explain("e", "a", { viewer: cleared, versionHash: r.experience.versionHash }))
    );
    expect(e.created?.by.decisionId).toBe("plan:compose:abc");
    expect(e.changes).toBe(0);
  });

  it("a branch starts from its source version's provenance", async () => {
    const lin = make();
    const v1 = ok(await lin.start(g("src"), user));
    const v2 = ok(
      await lin.compose({
        experienceId: "src",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"), agent)],
        by: agent,
      })
    );
    const b = ok(
      await lin.branch({
        from: { experienceId: "src", versionHash: v2.experience.versionHash },
        experienceId: "fork",
        by: user,
      })
    );
    const e = asAvail(
      ok(await lin.explain("fork", "a", { viewer: cleared, versionHash: b.experience.versionHash }))
    );
    expect(e.created).toMatchObject({ op: "insertNode", by: { decisionId: "plan:compose:abc" } });
  });

  it("refuses typed for an empty line and an unknown version", async () => {
    const lin = make();
    const empty = await lin.explain("none", "a", { viewer: cleared });
    expect(empty.ok).toBe(false);
    ok(await lin.start(g("e"), user));
    const unk = await lin.explain("e", "a", { viewer: cleared, versionHash: "sha256:nope" });
    expect(unk.ok).toBe(false);
    expect((await lin.provenance("e", "sha256:nope")).ok).toBe(false);
  });

  it("is derived from the log alone: explaining writes nothing", async () => {
    const events = new InMemoryLineageStore();
    const lin = new Lineage({ events, content: new InMemoryContentStore() });
    ok(await lin.start(g("e"), user));
    const before = (await events.read("e")).length;
    await lin.explain("e", "root", { viewer: cleared });
    expect((await events.read("e")).length).toBe(before);
  });
});
