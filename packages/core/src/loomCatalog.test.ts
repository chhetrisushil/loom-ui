import { builtinCatalog } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { loomCatalogFor } from "./loomCatalog";
import { testCatalog } from "./testCatalog.test-support";

describe("loomCatalogFor", () => {
  it("declares every kind the surface resolves to, with the base contract exactly, for built-ins", () => {
    const { catalog, findings } = loomCatalogFor(testCatalog, "web");
    expect(findings).toEqual([]);
    expect(catalog.id).toBe("test.semantic.v1/web");
    const metric = catalog.entries.find((e) => e.kind === "MetricCard");
    expect(metric).toEqual({
      kind: "MetricCard",
      props: ["unit", "format"],
      binding: "required",
    });
    expect(catalog.entries.map((e) => e.kind).sort()).toEqual([
      "DataTable",
      "MetricCard",
      "Note",
      "StatusBadge",
      "TimeSeries",
    ]);
  });
  it("uses the entry's own contract for a kind outside the base catalogue", () => {
    const { catalog } = loomCatalogFor(testCatalog, "web");
    expect(catalog.entries.find((e) => e.kind === "TimeSeries")).toEqual({
      kind: "TimeSeries",
      props: ["series"],
      binding: "required",
    });
  });
  it("omits degrade-only and unresolvable entries and does not fail on them (they are the compiler's per-node findings)", () => {
    const { catalog } = loomCatalogFor(testCatalog, "terminal");
    expect(catalog.entries.map((e) => e.kind).sort()).toEqual([
      "DataTable",
      "MetricCard",
      "StatusBadge",
    ]);
  });
  it("a non-built-in kind without a declared contract is a finding, not a silent pass", () => {
    const c = defineSemanticCatalog({
      id: "c",
      entries: [
        {
          name: "X",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "Mystery" } },
        },
      ],
    });
    const { catalog, findings } = loomCatalogFor(c, "web");
    expect(findings.map((f) => f.code)).toEqual(["undeclared-kind-contract"]);
    expect(catalog.entries).toEqual([]);
  });
  it("two entries resolving to one kind with different contracts is a conflict finding", () => {
    const c = defineSemanticCatalog({
      id: "c",
      entries: [
        {
          name: "A",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "K", props: ["x"], binding: "none" } },
        },
        {
          name: "B",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "K", props: ["y"], binding: "none" } },
        },
      ],
    });
    expect(loomCatalogFor(c, "web").findings.map((f) => f.code)).toEqual([
      "kind-contract-conflict",
    ]);
  });
  // I4. `validateExperience` reads the ENTRY's binding and loom's `validateBlueprint` reads the
  // resolved KIND's, so a pair that contradicts each other guarantees every node of that type a
  // finding from one side or the other, whatever the composer does. Report it once, here.
  it("an entry whose binding contradicts the kind it resolves to is a finding, and is skipped", () => {
    const c = defineSemanticCatalog({
      id: "c",
      entries: [
        {
          name: "Explainer",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "StatusBadge" } }, // builtin StatusBadge is binding: "required"
        },
      ],
    });
    const { catalog, findings } = loomCatalogFor(c, "web");
    expect(findings.map((f) => f.code)).toEqual(["binding-contract-conflict"]);
    expect(findings[0]?.message).toMatch(/Explainer@1\.0\.0.*"none".*StatusBadge.*"required"/);
    expect(catalog.entries.find((e) => e.kind === "StatusBadge")).toBeUndefined();
  });
  it("the conflict points the other way too, and `optional` absorbs either side", () => {
    const conflicting = defineSemanticCatalog({
      id: "c",
      entries: [
        {
          name: "Needy",
          version: "1.0.0",
          props: [],
          binding: "required",
          surfaces: { web: { kind: "Decoration", props: [], binding: "none" } },
        },
      ],
    });
    expect(loomCatalogFor(conflicting, "web").findings.map((f) => f.code)).toEqual([
      "binding-contract-conflict",
    ]);
    const tolerant = defineSemanticCatalog({
      id: "c",
      entries: [
        {
          name: "Either",
          version: "1.0.0",
          props: [],
          binding: "optional",
          surfaces: { web: { kind: "StatusBadge" } },
        },
        {
          name: "Loose",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "Maybe", props: [], binding: "optional" } },
        },
      ],
    });
    expect(loomCatalogFor(tolerant, "web").findings).toEqual([]);
  });
  // IR 2.0.0: a grid child's span rides in a `GridCell`, never in a widget's props. Neither the
  // base catalogue nor the derived one may declare `span` — a declaration here is what made the
  // old `props.span` smuggling pass `validateBlueprint`.
  it("base is builtinCatalog by default and no contract, base or derived, declares span", () => {
    for (const e of builtinCatalog.entries) expect(e.props).not.toContain("span");
    for (const e of loomCatalogFor(testCatalog, "web").catalog.entries)
      expect(e.props).not.toContain("span");
  });
});
