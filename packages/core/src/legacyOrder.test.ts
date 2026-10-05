import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { getExperience, mintVersionHash, putExperience, seal } from "./log";
import { type ContainerNode, type SemanticNode, compareSiblings, normalize } from "./node";
import { type Operation, replay } from "./operations";

// Hashes below were computed by the pre-U4 build (main's dist). Tied sibling keys used to keep
// INSERTION order inside `normalize`, and `normalize` is in the hash path — so an experience
// stored before the id tie-break must keep sealing, re-hashing and replaying to the same address.
const meta = { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
const leaf = (id: string, order: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
});
const ids = (e: { root: unknown }) => (e.root as ContainerNode).children.map((c) => c.id);

const TIED_SEAL = "sha256:ab1c93ca60b6bded2a3f8601b1d9d4b547c800e537b8e6e297b6c989d1f0c89d";
const MOVE_REPLAY = "sha256:ae99bcc86e6bbd0d06262cdde6bd22d7ae6610af1f8668b45a1fa237894617c1";

describe("legacy tied sibling keys keep their content address", () => {
  const tied = { ...g, root: { ...g.root, children: [leaf("zzz", "a"), leaf("aaa", "a")] } };
  it("seals to the address the pre-U4 build minted (insertion order, not id order)", () => {
    expect(seal(tied).versionHash).toBe(TIED_SEAL);
  });
  it("put then get of the tied experience round-trips with an unchanged hash", async () => {
    const store = new InMemoryContentStore();
    const put = await putExperience(store, seal(tied));
    if (!put.ok) throw new Error(put.finding.message);
    const got = await getExperience(store, put.ref);
    if (!got.ok) throw new Error(got.finding.message);
    expect(got.experience.versionHash).toBe(TIED_SEAL);
  });
  it("replaying an op log that produced tied keys gives the pre-U4 hash and order", () => {
    const tiedOps: Operation[] = [
      { type: "insertNode", parentId: "root", node: leaf("zzz", "a") },
      { type: "insertNode", parentId: "root", node: leaf("aaa", "a") },
    ];
    const r = replay(g, tiedOps);
    if (!r.ok) throw new Error(r.finding.message);
    expect(ids(r.value)).toEqual(["zzz", "aaa"]);
    expect(mintVersionHash(r.value)).toBe(TIED_SEAL);
    const moves: Operation[] = [
      { type: "insertNode", parentId: "root", node: leaf("zzz", "b") },
      { type: "insertNode", parentId: "root", node: leaf("aaa", "c") },
      { type: "insertNode", parentId: "root", node: leaf("mmm", "d") },
      { type: "moveNode", nodeId: "mmm", newParentId: "root", newOrder: "b" },
      { type: "moveNode", nodeId: "aaa", newParentId: "root", newOrder: "b" },
    ];
    const m = replay(g, moves);
    if (!m.ok) throw new Error(m.finding.message);
    expect(ids(m.value)).toEqual(["zzz", "mmm", "aaa"]);
    expect(mintVersionHash(m.value)).toBe(MOVE_REPLAY);
  });
  it("normalize (the hashed fold) keeps insertion order on a tie; the render order is total", () => {
    expect((normalize(tied.root) as ContainerNode).children.map((c) => c.id)).toEqual([
      "zzz",
      "aaa",
    ]);
    expect(
      (normalize(tied.root, compareSiblings) as ContainerNode).children.map((c) => c.id)
    ).toEqual(["aaa", "zzz"]);
    expect(compareSiblings(leaf("b", "a"), leaf("a", "a"))).toBeGreaterThan(0);
  });
});
