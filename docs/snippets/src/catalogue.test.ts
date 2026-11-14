// @vitest-environment happy-dom
// The code of docs/reference/catalogue.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { meta } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  type SemanticCatalog,
  apply,
  defineSemanticCatalog,
  genesis,
  resolveSurface,
  validateExperience,
} from "@loomwork/ui-core";
import { frameworkKindContracts } from "@loomwork/ui-renderer-lit/dom";
// #endregion imports

// #region catalogue
// A framework kind's loom contract, copied from `frameworkKindContracts` (the one declaration).
const contractOf = (kind: string) => {
  const found = frameworkKindContracts.find((c) => c.kind === kind);
  if (found === undefined) throw new Error(`no contract for ${kind}`);
  return found;
};

const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.ops.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: contractOf("Kpi"), terminal: contractOf("Kpi") },
    },
    {
      // The same widget under a second name; on the terminal it is drawn as a Metric.
      name: "Gauge",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: {
        web: contractOf("Kpi"),
        terminal: { degradeTo: { name: "Metric", version: "1.0.0" } },
      },
    },
    {
      name: "Remark",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"], // a string or { key, fallback }, resolved at compile
      binding: "none",
      surfaces: { web: contractOf("Note"), terminal: contractOf("Note") },
    },
  ],
});
// #endregion catalogue

// #region resolve
const gauge = resolveSurface(catalog, "Gauge", "1.0.0", "terminal");
if (gauge.ok) {
  gauge.kind; // "Kpi"
  gauge.via; // ["Gauge@1.0.0", "Metric@1.0.0"]
}
const missing = resolveSurface(catalog, "Gauge", "1.0.0", "voice");
if (!missing.ok) missing.finding.code; // "unresolvable-on-surface"
// #endregion resolve

// #region validate
const start = genesis({
  experienceId: "catalogue-demo",
  intent: { objective: "Show latency", source: "user" },
  meta,
});
const inserted = apply(start, {
  type: "insertNode",
  parentId: "root",
  node: {
    id: "p99",
    order: "V",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    props: { unit: "ms", colour: "red" }, // `colour` is not declared by the entry
    binding: { handle: "latency", priority: "P0" }, // no provider declares `latency`
  },
});
if (!inserted.ok) throw new Error(inserted.finding.message);

const result = validateExperience(inserted.value, catalog, "web");
result.findings.map((f) => `${f.severity} ${f.code}`);
// ["warn unknown-handle", "error undeclared-prop"]
// #endregion validate

describe("docs/reference/catalogue.md", () => {
  it("resolves a degrade chain and refuses a surface the entry lacks", () => {
    expect(gauge.ok && gauge.kind).toBe("Kpi");
    expect(gauge.ok && gauge.via).toEqual(["Gauge@1.0.0", "Metric@1.0.0"]);
    expect(!missing.ok && missing.finding.code).toBe("unresolvable-on-surface");
  });

  it("validates a node against its entry", () => {
    expect(result.nodes).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => `${f.severity} ${f.code}`).sort()).toEqual([
      "error undeclared-prop",
      "warn unknown-handle",
    ]);
  });

  it("keeps docs/reference/catalogue.md in step with this file", () => {
    expectDocMirrors("docs/reference/catalogue.md", "catalogue.test.ts");
  });
});
