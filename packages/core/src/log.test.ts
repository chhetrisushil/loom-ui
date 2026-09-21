import { InMemoryContentStore, encodeValue } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { type Experience, genesis } from "./experience";
import { EXPERIENCE_COMPOSED, getExperience, mintVersionHash, putExperience, seal } from "./log";
import type { ContainerNode, SemanticNode } from "./node";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });

type PutOk = { ok: true; experience: Experience; ref: { __loomContent: string } };
const ok = (r: PutOk | { ok: false; finding: { message: string } }): PutOk => {
  if (!r.ok) throw new Error(r.finding.message);
  return r;
};

describe("mintVersionHash / seal", () => {
  it("is a sha256 content address over the artifact, stable across authorship and child order", () => {
    const h = mintVersionHash(g);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mintVersionHash({ ...g, meta: { ...meta, author: "b" } })).toBe(h);
    expect(mintVersionHash({ ...g, intent: { objective: "y", source: "user" } })).not.toBe(h);
    expect(seal(g).versionHash).toBe(h);
    expect(seal(seal(g)).versionHash).toBe(h);
  });

  // C1. The hash used to be taken over the RAW object, whose `JSON.stringify` follows key
  // INSERTION order — so the same artifact written by two composers in two key orders minted two
  // hashes, and a stored artifact read back (and re-hashed after a zod parse, which reorders and
  // defaults) failed its own tamper check.
  it("does not depend on key insertion order anywhere in the artifact", () => {
    const nodeA: SemanticNode = {
      id: "m",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 4,
      props: { unit: "ms", format: "short" },
    };
    const nodeB: SemanticNode = {
      // every key written in a different order from nodeA, `props` included
      props: { format: "short", unit: "ms" },
      span: 4,
      typeVersion: "1.0.0",
      type: "Metric",
      kind: "semantic",
      order: "V",
      id: "m",
    } as SemanticNode;
    const provider = (keysReversed: boolean) =>
      keysReversed
        ? ({
            cachePolicy: { scope: "global" as const, ttlSeconds: 60 },
            outputShapeHash: "sha256:o",
            reshaping: { scriptRef: "sha256:s", engine: "JSONPath" as const },
            executionGraph: [],
            handle: "h",
          } as never)
        : {
            handle: "h",
            executionGraph: [],
            reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
            outputShapeHash: "sha256:o",
            cachePolicy: { ttlSeconds: 60, scope: "global" as const },
          };
    const root = (child: SemanticNode): ContainerNode => ({
      ...(g.root as ContainerNode),
      children: [child],
    });
    const one: Experience = {
      ...g,
      intent: { objective: "x", source: "user" },
      root: root(nodeA),
      providers: { h: provider(false) },
    };
    const two: Experience = {
      ...g,
      intent: { source: "user", objective: "x" } as never,
      root: root(nodeB),
      providers: { h: provider(true) },
    };
    expect(mintVersionHash(two)).toBe(mintVersionHash(one));
  });

  it("does not depend on whether the schema's defaults were spelled out", () => {
    const withDefaults: Experience = {
      ...g,
      providers: {
        h: {
          handle: "h",
          executionGraph: [
            {
              stepId: "s1",
              toolName: "t",
              toolVersion: "1.0.0",
              toolSchemaHash: "sha256:h",
              arguments: {},
              dependsOn: [],
              idempotent: true,
            },
          ],
          reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
          outputShapeHash: "sha256:o",
          cachePolicy: { ttlSeconds: 60, scope: "global" },
        },
      },
    };
    const omitted: Experience = {
      ...withDefaults,
      providers: {
        h: {
          ...withDefaults.providers.h,
          executionGraph: [
            {
              stepId: "s1",
              toolName: "t",
              toolVersion: "1.0.0",
              toolSchemaHash: "sha256:h",
              arguments: {},
            },
          ],
        } as never,
      },
    };
    expect(mintVersionHash(omitted)).toBe(mintVersionHash(withDefaults));
  });
});

describe("putExperience / getExperience", () => {
  it("round-trips a sealed experience and dedupes identical artifacts", async () => {
    const store = new InMemoryContentStore();
    const a = ok(await putExperience(store, g));
    const b = ok(await putExperience(store, { ...g, meta: { ...meta, author: "b" } }));
    expect(a.experience.versionHash).toBe(mintVersionHash(g));
    // Test-adjustment note (pre-declared by the brief): what is STORED includes `meta`, so two
    // authors of the same artifact store different bytes under different refs, even though their
    // artifact identity (versionHash) is the same. The original assertion here compared refs for
    // equality; that contradicts the design, so it is replaced with the pair below.
    expect(a.experience.versionHash).toBe(b.experience.versionHash);
    expect(a.ref.__loomContent).not.toBe(b.ref.__loomContent);
    const back = await getExperience(store, a.ref);
    expect(back.ok && back.experience).toEqual(a.experience);
  });

  // C1, end to end: the shape a composer actually writes — keys in its own order, schema
  // defaults left off — used to store fine and then fail its own tamper check on read.
  it("round-trips an artifact written in non-schema key order with defaults omitted", async () => {
    const store = new InMemoryContentStore();
    const node = {
      span: 6,
      props: { format: "short", unit: "ms" },
      kind: "semantic",
      typeVersion: "1.0.0",
      type: "Metric",
      order: "V",
      id: "m",
      binding: { priority: "P1", handle: "h" },
    } as unknown as SemanticNode;
    const exp = {
      meta,
      versionHash: "",
      parents: [],
      intent: { source: "user", objective: "x" },
      experienceId: "exp-1",
      vocabularyFloor: { minVersion: "0.0.0", types: [] },
      providers: {
        h: {
          cachePolicy: { scope: "global", ttlSeconds: 60 },
          outputShapeHash: "sha256:o",
          reshaping: { scriptRef: "sha256:s", engine: "JSONPath" },
          // dependsOn / idempotent deliberately omitted — the schema defaults them
          executionGraph: [
            {
              arguments: {},
              toolSchemaHash: "sha256:h",
              toolVersion: "1.0.0",
              toolName: "t",
              stepId: "s1",
            },
          ],
          handle: "h",
        },
      },
      root: { ...(g.root as ContainerNode), children: [node] },
    } as unknown as Experience;
    const put = await putExperience(store, exp);
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    const back = await getExperience(store, put.ref);
    expect(back.ok).toBe(true);
    expect(back.ok && back.experience.providers.h?.executionGraph[0]?.idempotent).toBe(true);
  });

  it("a value canonical JSON cannot represent is an artifact-unhashable finding, not a throw", async () => {
    const store = new InMemoryContentStore();
    const node: SemanticNode = {
      id: "m",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 4,
      props: { unit: Number.NaN },
    };
    const exp: Experience = {
      ...g,
      root: { ...(g.root as ContainerNode), children: [node] },
    };
    const r = await putExperience(store, exp);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.finding.code).toBe("artifact-unhashable");
    expect(!r.ok && r.finding.message).toMatch(/non-finite/);
  });

  it("a missing ref and a tampered blob are findings, not throws", async () => {
    const store = new InMemoryContentStore();
    const missing = await getExperience(store, { __loomContent: `sha256:${"0".repeat(64)}` });
    expect(!missing.ok && missing.finding.code).toBe("artifact-missing");
    const forged = { ...seal(g), versionHash: `sha256:${"f".repeat(64)}` };
    const ref = await store.put(encodeValue(forged));
    const r = await getExperience(store, ref);
    expect(!r.ok && r.finding.code).toBe("artifact-tampered");
    const junk = await store.put(encodeValue({ not: "an experience" }));
    const j = await getExperience(store, junk);
    expect(!j.ok && j.finding.code).toBe("artifact-invalid");
  });

  // I1: the depth probe runs after decode and BEFORE `Experience.safeParse`, whose recursive
  // node schema is what a deep blob would otherwise blow up inside.
  it("a blob nested past the cap is a finding, not a RangeError out of zod", async () => {
    const store = new InMemoryContentStore();
    let child: ContainerNode = {
      id: "n0",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [],
    };
    for (let i = 1; i < 300; i++)
      child = {
        id: `n${i}`,
        order: "V",
        kind: "container",
        direction: "column",
        span: 12,
        children: [child],
      };
    const ref = await store.put(encodeValue({ ...g, root: child }));
    const r = await getExperience(store, ref);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.finding.code).toBe("artifact-invalid");
    expect(!r.ok && r.finding.message).toMatch(/nests 300 levels/);
  });

  it("names the userspace event and its payload shape", () => {
    expect(EXPERIENCE_COMPOSED).toBe("EXPERIENCE_COMPOSED");
  });
});
