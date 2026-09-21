import {
  type CatalogEntry,
  type WidgetCatalog,
  builtinCatalog,
  defineWidgetCatalog,
} from "@loom/blueprint-runtime";
import { type SemanticCatalog, type Surface, resolveSurface } from "./catalog";
import type { Finding } from "./experience";

// ── The loom catalogue this framework compiles against ────────────────────────
// ADR 0088 D2: loom checks the catalogue it is given and does not define one. The compiler emits
// each node's `span` as a widget prop (loom's layouts have no per-child span), and loom's
// `validateBlueprint` would flag that as `undeclared-prop` against `builtinCatalog` (ADR 0096 D4).
// So the framework owns its loom catalogue: derived from the semantic catalogue, one entry per
// kind a surface resolves to, with the base contract plus `span`. A kind outside the base must
// declare its own contract on the resolution — both fields — or it is a finding.

export const SPAN_PROP = "span";

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
      contract = { kind: r.kind, props: [...fromBase.props, SPAN_PROP], binding: fromBase.binding };
    } else if (r.contract.props !== undefined && r.contract.binding !== undefined) {
      contract = {
        kind: r.kind,
        props: [...r.contract.props, SPAN_PROP],
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
