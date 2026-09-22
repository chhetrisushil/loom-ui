import {
  type CatalogEntry,
  type WidgetCatalog,
  builtinCatalog,
  defineWidgetCatalog,
} from "@loom/blueprint-runtime";
import { type SemanticCatalog, type Surface, resolveSurface } from "./catalog";
import type { Finding } from "./experience";

// ── The loom catalogue this framework compiles against ────────────────────────
// ADR 0088 D2: loom checks the catalogue it is given and does not define one. The framework still
// owns its loom catalogue — the semantic catalogue names kinds (`TimeSeries`, `Note`) that are not
// in `builtinCatalog` — so it is derived here: one entry per kind a surface resolves to, carrying
// the base contract EXACTLY. A kind outside the base must declare its own contract on the
// resolution — both fields — or it is a finding.
//
// Nothing framework-owned is added to a contract. `span` used to be (loom's layouts had no
// per-child span, so the compiler smuggled it through `props`); Blueprint IR 2.0.0 carries it in a
// `GridCell` instead, and a contract that still declared it would re-legalise exactly the prop
// loom's `validateBlueprint` is there to refuse.

export function loomCatalogFor(
  catalog: SemanticCatalog,
  surface: Surface,
  base: WidgetCatalog = builtinCatalog
): { catalog: WidgetCatalog; findings: Finding[] } {
  const baseByKind = new Map(base.entries.map((e) => [e.kind, e] as const));
  const entries = new Map<string, CatalogEntry>();
  const findings: Finding[] = [];

  for (const entry of catalog.entries) {
    const res = entry.surfaces[surface];
    if (!res || "degradeTo" in res) continue; // degrade-only: its target contributes the kind
    const r = resolveSurface(catalog, entry.name, entry.version, surface);
    if (!r.ok) continue; // per-node findings belong to validateExperience
    const fromBase = baseByKind.get(r.kind);
    let contract: CatalogEntry;
    if (fromBase) {
      contract = { kind: r.kind, props: [...fromBase.props], binding: fromBase.binding };
    } else if (r.contract.props !== undefined && r.contract.binding !== undefined) {
      contract = {
        kind: r.kind,
        props: [...r.contract.props],
        binding: r.contract.binding,
      };
    } else {
      findings.push({
        code: "undeclared-kind-contract",
        severity: "error",
        message: `"${entry.name}@${entry.version}" resolves to "${r.kind}" on "${surface}", which is not in "${base.id}" and declares no props/binding contract`,
      });
      continue;
    }
    // The semantic entry declares whether the TYPE renders bound data; the resolved kind's
    // contract declares whether the WIDGET does. `optional` absorbs either neighbour, but
    // `required` against `none` is a straight contradiction in whichever direction it points —
    // and the two halves are enforced by different checks (`validateExperience` reads the entry,
    // loom's `validateBlueprint` reads the contract), so an unreconciled pair means every node of
    // that type is guaranteed a finding from one side or the other, whatever the composer does.
    // Reporting it once here, against the catalogue, beats reporting it per node forever.
    if (
      (entry.binding === "required" && contract.binding === "none") ||
      (entry.binding === "none" && contract.binding === "required")
    ) {
      findings.push({
        code: "binding-contract-conflict",
        severity: "error",
        message: `"${entry.name}@${entry.version}" declares binding "${entry.binding}" but the kind it resolves to on "${surface}", "${r.kind}", declares "${contract.binding}"`,
      });
      continue;
    }
    const prev = entries.get(r.kind);
    if (
      prev &&
      (prev.binding !== contract.binding ||
        JSON.stringify([...prev.props].sort()) !== JSON.stringify([...contract.props].sort()))
    ) {
      findings.push({
        code: "kind-contract-conflict",
        severity: "error",
        message: `two entries resolve to "${r.kind}" on "${surface}" with different contracts`,
      });
      continue;
    }
    entries.set(r.kind, contract);
  }
  return {
    catalog: defineWidgetCatalog({
      id: `${catalog.id}/${surface}`,
      entries: [...entries.values()],
    }),
    findings,
  };
}
