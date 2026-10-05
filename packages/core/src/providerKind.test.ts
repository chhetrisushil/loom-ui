import { canonicalJson } from "@loom/core";
import { describe, expect, it } from "vitest";
import { toolsOf } from "./classes";
import { Experience, type ProviderSpec, genesis } from "./experience";
import { experienceHandles } from "./handles";
import { mintVersionHash } from "./log";
import type { SemanticNode } from "./node";
import { type Operation, replay } from "./operations";
import { DEFAULT_STEP_KIND, stepKind, toolKey } from "./steps";

// U3: a provider step names a KIND (default: MCP). The MCP step has no `kind` key at all, so an
// experience written before the kind existed hashes exactly as it did.

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const base = (id = "e") =>
  genesis({ experienceId: id, intent: { objective: "x", source: "user" }, meta });
const step = (toolName: string, kind?: string) => ({
  stepId: "s1",
  ...(kind !== undefined && { kind }),
  toolName,
  toolVersion: "1",
  toolSchemaHash: "sha256:abc",
  arguments: { limit: 5 },
  dependsOn: [],
  idempotent: true,
});
const spec = (handle: string, toolName: string, kind?: string): ProviderSpec => ({
  handle,
  executionGraph: [step(toolName, kind)],
  reshaping: { engine: "JSONPath", scriptRef: "rows" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" },
});
const run = (ops: Operation[], from = base()) => {
  const r = replay(from, ops);
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const node = (id: string, handle: string, sensitivity?: "secret"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });
const remap = (handle: string, toolName: string, kind?: string): Operation => ({
  type: "remapProvider",
  handle,
  spec: spec(handle, toolName, kind),
});
const classOf = (e: Experience, h: string) =>
  experienceHandles(e).find((u) => u.handle === h)?.sensitivity;

describe("an experience whose steps are MCP steps hashes as before the step kind existed", () => {
  // Minted on origin/main b933057, BEFORE `kind` existed (the existing goldens have no steps).
  const GOLDEN = "sha256:a5e3de81184bfecc54efa7a8c8f5c6d765ecdf30f528c500e8723b9fc22306cd";
  it("keeps its pinned versionHash and its parsed step has no `kind` key", () => {
    const e = run([remap("h1", "db.list")], base("exp-golden-mcp"));
    expect(mintVersionHash(e)).toBe(GOLDEN);
    expect("kind" in (e.providers.h1?.executionGraph[0] ?? {})).toBe(false);
    expect(canonicalJson(e.providers.h1)).not.toContain("kind");
  });
});

describe("a step's kind", () => {
  it("defaults to MCP; an explicit non-MCP kind round-trips and changes the address", () => {
    expect(DEFAULT_STEP_KIND).toBe("mcp");
    const mcp = run([remap("h1", "db.list")]);
    const eff = run([remap("h1", "db.list", "loom-effect")]);
    expect(stepKind(mcp.providers.h1?.executionGraph[0] as never)).toBe("mcp");
    expect(eff.providers.h1?.executionGraph[0]?.kind).toBe("loom-effect");
    expect(mintVersionHash(eff)).not.toBe(mintVersionHash(mcp));
    expect(Experience.parse(JSON.parse(JSON.stringify(eff)))).toEqual(eff);
  });
  it('refuses an explicit `kind: "mcp"` (one spelling per content) and a malformed kind', () => {
    for (const bad of ["mcp", "", "Has Space", "UPPER", "a:b", "x".repeat(65)])
      expect(replay(base(), [remap("h1", "t", bad)]).ok, bad).toBe(false);
  });
});

describe("class stickiness is per (kind, target) — security parity for every kind", () => {
  it("toolKey keeps the MCP spelling and namespaces every other kind", () => {
    expect(toolKey(step("pay") as never)).toBe("pay");
    expect(toolKey(step("pay", "loom-effect") as never)).toBe("loom-effect:pay");
    expect(toolsOf(spec("h", "pay", "loom-effect"))).toEqual(["loom-effect:pay"]);
  });
  it("a class on a non-MCP target sticks, and a NEW handle on it inherits", () => {
    const e = run([
      remap("h1", "pay", "loom-effect"),
      ins(node("a", "h1", "secret")),
      { type: "removeNode", nodeId: "a" },
      { type: "removeProvider", handle: "h1" },
      remap("h2", "pay", "loom-effect"),
      ins(node("b", "h2")),
    ]);
    expect(classOf(e, "h2")).toBe("secret");
  });
  it("an MCP tool and a loom effect with the same name do not share a class", () => {
    const e = run([
      remap("h1", "pay", "loom-effect"),
      ins(node("a", "h1", "secret")),
      remap("h2", "pay"),
      ins(node("b", "h2")),
    ]);
    expect(classOf(e, "h2")).toBeUndefined();
    const f = run([
      remap("h1", "pay"),
      ins(node("a", "h1", "secret")),
      remap("h2", "pay", "loom-effect"),
      ins(node("b", "h2")),
    ]);
    expect(classOf(f, "h2")).toBeUndefined();
  });
});
