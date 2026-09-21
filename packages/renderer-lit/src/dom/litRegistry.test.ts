import { FRAMEWORK_KINDS } from "@loom-ui/core";
import { builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { LIT_ONLY_KINDS, frameworkKindContracts, litRegistry } from "./litRegistry";

describe("litRegistry parity", () => {
  it("covers every kind in loom's built-in catalogue, so one web compile renders on React or Lit", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it("names the Lit-only kinds explicitly and declares their loom contracts", () => {
    expect([...LIT_ONLY_KINDS].sort()).toEqual([...FRAMEWORK_KINDS].sort());
    for (const k of FRAMEWORK_KINDS) expect(litRegistry.has(k)).toBe(true);
    expect(frameworkKindContracts.map((c) => c.kind).sort()).toEqual([...FRAMEWORK_KINDS].sort());
    for (const c of frameworkKindContracts) expect(c.binding).toBe("required");
  });
  it("the registry's extras beyond the catalogue are exactly the Lit-only kinds", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect([...report.extra].sort()).toEqual([...LIT_ONLY_KINDS].sort());
  });
});
