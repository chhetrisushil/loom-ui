import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
  mediaCatalogEntries,
} from "@loom-ui/core";
import { builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { litRegistry } from "./dom/litRegistry";
import { createMediaLitRegistry, mediaKindContracts, registerMediaWidgets } from "./media";

describe("the opt-in media entry", () => {
  it("registers exactly the media kinds, on top of the default registry's kinds", () => {
    const reg = createMediaLitRegistry();
    for (const k of ["Image", "Audio", "Video", "File", "MediaInput"])
      expect(reg.has(k)).toBe(true);
    expect(catalogCoverage(builtinCatalog, reg).missing).toEqual([]);
    expect(mediaKindContracts.map((c) => c.kind).sort()).toEqual([
      "Audio",
      "File",
      "Image",
      "MediaInput",
      "Video",
    ]);
    expect(registerMediaWidgets(litRegistry)).toBe(litRegistry);
    for (const k of ["Image", "MediaInput"]) litRegistry.has(k); // (registered on the shared one above; see next test)
  });

  it("the standard media catalogue entries compile clean against the media registry (no findings)", () => {
    const catalog = defineSemanticCatalog({ id: "media.v1", entries: mediaCatalogEntries() });
    const g = genesis({
      experienceId: "m",
      intent: { objective: "media", source: "user" },
      meta: { author: "t", createdAt: "2026-10-08T00:00:00Z", sourceKind: "prompt" },
    });
    const kinds = catalog.entries.map((e) => e.name);
    const children: SemanticNode[] = kinds.map((name, i) => ({
      id: `n${i}`,
      order: String.fromCharCode(65 + i),
      kind: "semantic",
      type: name,
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      ...(name !== "MediaInput" && { binding: { handle: `h${i}`, priority: "P1" as const } }),
    }));
    const providers: Record<string, unknown> = {};
    for (const n of children)
      if (n.binding)
        providers[n.binding.handle] = {
          handle: n.binding.handle,
          executionGraph: [],
          reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
          outputShapeHash: "sha256:o",
          cachePolicy: { ttlSeconds: 60, scope: "global" },
        };
    const r = compile(
      { ...g, root: { ...(g.root as ContainerNode), children }, providers: providers as never },
      {
        surface: "web",
        catalog,
        hydrationProjectionId: "hydration",
        hydrationProjectionVersion: "1.0.0",
        registry: createMediaLitRegistry(),
      }
    );
    expect(r.findings).toEqual([]);
    expect(r.blueprint).toBeDefined();
  });
});
