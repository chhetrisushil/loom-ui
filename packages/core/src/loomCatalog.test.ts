import { builtinCatalog } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { SPAN_PROP, loomCatalogFor } from "./loomCatalog";
import { testCatalog } from "./testCatalog";

describe("loomCatalogFor", () => {
  it("declares every kind the surface resolves to, with base props plus span for built-ins", () => {
    const { catalog, findings } = loomCatalogFor(testCatalog, "web");
    expect(findings).toEqual([]);
    expect(catalog.id).toBe("test.semantic.v1/web");
    const metric = catalog.entries.find((e) => e.kind === "MetricCard");
    expect(metric).toEqual({
      kind: "MetricCard",
      props: ["unit", "format", SPAN_PROP],
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
      props: ["series", SPAN_PROP],
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
  it("base is builtinCatalog by default and every base entry stays intact", () => {
    for (const e of builtinCatalog.entries) expect(e.props).not.toContain(SPAN_PROP);
  });
});
