import {
  type Blueprint,
  type CatalogEntry,
  type Layout,
  type RendererRegistry,
  type Widget,
  type WidgetCatalog,
  blueprint$,
  catalogCoverage,
  customWidget$,
  flex,
  grid,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import {
  type SemanticCatalog,
  type Surface,
  findEntry,
  resolveSurface,
  validateExperience,
} from "./catalog";
import type { Experience, Finding } from "./experience";
import { SPAN_PROP, loomCatalogFor } from "./loomCatalog";
import { type ContainerNode, type ExperienceNode, type LocalizedText, normalize } from "./node";

// ── Experience → loom Blueprint ───────────────────────────────────────────────
// Pure and deterministic: same inputs, byte-identical output. A semantic node becomes a loom
// Widget whose `id` IS the node id (so a WidgetAction maps straight back), whose `kind` is the
// surface resolution, whose binding points at the hydration projection's `values.<handle>`, and
// whose `span` rides in props — declared by the derived loom catalogue (loomCatalog.ts). Nothing
// semantic is smuggled into props: the experience is the source of truth, the blueprint derived.

export interface CompileOptions {
  readonly surface: Surface;
  readonly catalog: SemanticCatalog;
  readonly hydrationProjectionId: string;
  readonly hydrationProjectionVersion: string;
  /** Default: the label's fallback text. */
  readonly resolveLabel?: (label: LocalizedText) => string;
  /** Base loom catalogue for built-in kinds; default `builtinCatalog`. */
  readonly baseCatalog?: WidgetCatalog;
  /** If given, kinds the derived catalogue declares but this registry lacks become `renderer-coverage` findings. */
  readonly registry?: RendererRegistry<unknown>;
}

export interface CompileResult {
  readonly blueprint: Blueprint;
  readonly findings: readonly Finding[];
  /** True iff there are no error-severity findings. The blueprint is produced either way, so a caller can degrade. */
  readonly ok: boolean;
}

export function compile(exp: Experience, opts: CompileOptions): CompileResult {
  const findings: Finding[] = [];
  const semantic = validateExperience(exp, opts.catalog, opts.surface);
  findings.push(...semantic.findings);
  const derived = loomCatalogFor(opts.catalog, opts.surface, opts.baseCatalog);
  findings.push(...derived.findings);
  const resolveLabel = opts.resolveLabel ?? ((l: LocalizedText) => l.fallback);
  const catalogByKind = new Map(derived.catalog.entries.map((e) => [e.kind, e] as const));

  const layout = compileContainer(
    normalize(exp.root) as ContainerNode,
    exp,
    opts,
    resolveLabel,
    catalogByKind,
    findings
  );
  const blueprint = blueprint$({
    id: `${exp.experienceId}@${exp.versionHash || "unsealed"}`,
    title: exp.intent.objective,
    layout,
    projections: [opts.hydrationProjectionId],
    projectionVersions: { [opts.hydrationProjectionId]: opts.hydrationProjectionVersion },
  });

  // loom's own check, against the framework's catalogue: a compiler defect that emits an
  // off-catalogue kind or an undeclared prop is caught here rather than trusted.
  const loomReport = validateBlueprint(blueprint, derived.catalog);
  for (const f of loomReport.findings) {
    if (findings.some((g) => g.nodeId === f.nodeId && sameDefect(g.code, f.code))) continue; // already reported semantically
    findings.push({
      code: `loom:${f.code}`,
      severity: f.severity,
      message: f.message,
      nodeId: f.nodeId,
    });
  }
  if (opts.registry) {
    const cov = catalogCoverage(derived.catalog, opts.registry);
    for (const kind of cov.missing)
      findings.push({
        code: "renderer-coverage",
        severity: "error",
        message: `no renderer registered for "${kind}" (declared by ${derived.catalog.id})`,
      });
  }
  return { blueprint, findings, ok: findings.every((f) => f.severity !== "error") };
}

/** loom's finding codes that restate one this compiler already reported for the same node. */
function sameDefect(ours: string, loomCode: string): boolean {
  return (
    // Defensive: props are filtered to the derived contract before the loom pass, so this should
    // not fire; kept so a future compiler change cannot double-report.
    (ours === "undeclared-prop" && loomCode === "undeclared-prop") ||
    (ours === "missing-binding" && loomCode === "missing-binding") ||
    (ours === "duplicate-node-id" && loomCode === "duplicate-node-id")
  );
}

function compileContainer(
  node: ContainerNode,
  exp: Experience,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string,
  catalogByKind: ReadonlyMap<string, CatalogEntry>,
  findings: Finding[]
): Layout {
  const children: Array<Widget | Layout> = [];
  for (const child of node.children) {
    const out = compileNode(child, exp, opts, resolveLabel, catalogByKind, findings);
    if (out !== undefined) children.push(out);
  }
  if (node.direction === "grid")
    return grid({ columns: 12, ...(node.gap !== undefined && { gap: node.gap }), children });
  return flex({
    direction: node.direction,
    ...(node.gap !== undefined && { gap: node.gap }),
    children,
  });
}

function compileNode(
  node: ExperienceNode,
  exp: Experience,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string,
  catalogByKind: ReadonlyMap<string, CatalogEntry>,
  findings: Finding[]
): Widget | Layout | undefined {
  if (node.kind === "container")
    return compileContainer(node, exp, opts, resolveLabel, catalogByKind, findings);
  const r = resolveSurface(opts.catalog, node.type, node.typeVersion, opts.surface, node.id);
  if (!r.ok) return undefined; // the finding was recorded by validateExperience; the node is omitted, never faked
  // A resolved kind with no entry in the derived catalogue (loomCatalogFor already reported
  // `undeclared-kind-contract` or `kind-contract-conflict` for it) has no allow-list to filter
  // props against — emitting the widget anyway would let every semantic prop reach `props`
  // unfiltered, on exactly the path a malformed catalogue produces. Omit the node instead, with
  // its own finding, the same treatment as an unresolvable node.
  const contract = catalogByKind.get(r.kind);
  if (!contract) {
    findings.push({
      code: "kind-without-contract",
      severity: "error",
      message: `"${node.type}@${node.typeVersion}" resolves to "${r.kind}" on "${opts.surface}", which has no contract in the derived catalogue`,
      nodeId: node.id,
    });
    return undefined;
  }
  // A degrade chain can land on a kind whose declared contract differs from the ORIGINAL semantic
  // type's own props (e.g. Trend@series degrading to a DataTable@columns): the resolved kind's
  // renderer only understands its own contract, so a prop outside it is dropped here rather than
  // smuggled through and flagged by loom's validateBlueprint as an exfiltration risk. Dropping is
  // never silent: a prop the node's OWN type legitimately declares, but the resolved kind cannot
  // render, is a `prop-not-rendered` warn — degradation loses fidelity, and that loss is visible.
  // A prop that is not even declared by the node's own type is `validateExperience`'s territory
  // (`undeclared-prop`, an error) and is not reported twice here.
  const allowedProps = new Set(contract.props);
  const ownProps = new Set(findEntry(opts.catalog, node.type, node.typeVersion)?.props ?? []);
  const props = Object.fromEntries(
    Object.entries(node.props).filter(([key]) => {
      if (allowedProps.has(key)) return true;
      if (ownProps.has(key))
        findings.push({
          code: "prop-not-rendered",
          severity: "warn",
          message: `prop "${key}" of "${node.type}@${node.typeVersion}" is not rendered by "${r.kind}" on "${opts.surface}"`,
          nodeId: node.id,
        });
      return false;
    })
  );
  return customWidget$({
    kind: r.kind,
    id: node.id,
    ...(node.label !== undefined && { title: resolveLabel(node.label) }),
    props: { ...props, [SPAN_PROP]: node.span },
    ...(node.binding !== undefined && {
      binding: { projectionId: opts.hydrationProjectionId, path: `values.${node.binding.handle}` },
    }),
  });
}
