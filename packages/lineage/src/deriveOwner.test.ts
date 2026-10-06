import { type ContainerNode, type Experience, findNode, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { branchArtifact, revertArtifact } from "./derive";

// U15: `ContainerNode.owner` is part of the artifact's content, so a revert and a branch — which
// adopt an older artifact whole — must carry it, or a planner's own containers would turn locked.
const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };
const g = (id: string) =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
const by = { source: "user" as const, agentId: "u1" };
const a = { by, at: "2026-10-07T00:00:00Z" };

const withOwned = (): Experience => {
  const node: ContainerNode = {
    id: "grp",
    order: "a",
    kind: "container",
    direction: "column",
    span: 12,
    owner: "planner",
    role: "tabs",
    children: [],
  };
  const r = replay(g("e"), [{ type: "insertNode", parentId: "root", node }]);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
};

describe("container owner across derived versions", () => {
  it("a revert to an owned version keeps owner (and role)", () => {
    const target = withOwned();
    const head = seal({ ...g("e"), parents: [target.versionHash] });
    const back = seal(revertArtifact(head, target, a));
    expect(findNode(back.root, "grp")).toMatchObject({ owner: "planner", role: "tabs" });
    expect(back.versionHash).not.toBe(head.versionHash);
  });

  it("a branch from an owned version keeps owner", () => {
    const source = withOwned();
    const forked = seal(branchArtifact(source, source, "e2", a));
    expect(findNode(forked.root, "grp")).toMatchObject({ owner: "planner" });
  });
});
