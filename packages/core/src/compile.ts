import {
  type Blueprint,
  type CatalogEntry,
  type Layout,
  type RendererRegistry,
  type Widget,
  type WidgetCatalog,
  blueprint$,
  catalogCoverage,
  cell,
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
import { loomCatalogFor } from "./loomCatalog";
import {
  type ContainerNode,
  type ExperienceNode,
  LocalizedText,
  MAX_TREE_DEPTH,
  normalize,
  treeDepth,
} from "./node";

// ── Experience → loom Blueprint ───────────────────────────────────────────────
// Pure and deterministic: same inputs, byte-identical output. A semantic node becomes a loom
// Widget whose `id` IS the node id (so a WidgetAction maps straight back), whose `kind` is the
// surface resolution, whose `source` records the semantic type and the degrade chain that reached
// that kind, and whose binding points at the hydration projection's `values.<handle>` with
// `status.<handle>` as its status channel. A node's `span` rides in the `GridCell` its parent grid
// wraps it in (Blueprint IR 2.0.0). Nothing semantic is smuggled into props: the experience is the
// source of truth, the blueprint derived.

/**
 * The hydration projection's top-level key. A widget's binding path is `values.<handle>`, and the
 * projection that hydrates the surface must publish under the same prefix — one spelling, in one
 * place, so the two halves of the contract cannot drift apart in a string literal.
 */
export const HYDRATION_VALUES_PREFIX = "values";

/** The binding path a provider `handle` hydrates through. */
export function hydrationPath(handle: string): string {
  return `${HYDRATION_VALUES_PREFIX}.${handle}`;
}

/**
 * The hydration projection's status key. A binding declares `status.<handle>` as its status
 * channel (loom ADR 0097 D2), in the same projection state its value reads from, so a renderer
 * reads delivery state off the blueprint rather than re-deriving hydration's keying.
 */
export const HYDRATION_STATUS_PREFIX = "status";

/** The status path a provider `handle` publishes its delivery state under. */
export function hydrationStatusPath(handle: string): string {
  return `${HYDRATION_STATUS_PREFIX}.${handle}`;
}

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
  // Before `validateExperience`, `normalize` or any recursive descent: a tree past the cap is a
  // finding with an empty blueprint, never a `RangeError` thrown out of a total function.
  const depth = treeDepth(exp.root);
  if (depth > MAX_TREE_DEPTH) {
    return {
      blueprint: blueprint$({
        id: `${exp.experienceId}@${exp.versionHash || "unsealed"}`,
        title: exp.intent.objective,
        layout: flex({ direction: "column", children: [] }),
        projections: [opts.hydrationProjectionId],
        projectionVersions: { [opts.hydrationProjectionId]: opts.hydrationProjectionVersion },
      }),
      findings: [
        {
          code: "tree-too-deep",
          severity: "error",
          message: `the experience tree nests ${depth} levels, over the ${MAX_TREE_DEPTH} limit`,
          nodeId: exp.root.id,
        },
      ],
      ok: false,
    };
  }
  const semantic = validateExperience(exp, opts.catalog, opts.surface);
  findings.push(...semantic.findings);
  const derived = loomCatalogFor(opts.catalog, opts.surface, opts.baseCatalog);
  findings.push(...derived.findings);
  const resolveLabel = opts.resolveLabel ?? ((l: LocalizedText) => l.fallback);
  const catalogByKind = new Map(derived.catalog.entries.map((e) => [e.kind, e] as const));

  const layout = compileContainer(
    normalize(exp.root) as ContainerNode,
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
    (ours === "unexpected-binding" && loomCode === "unexpected-binding") ||
    (ours === "duplicate-node-id" && loomCode === "duplicate-node-id")
  );
}

function compileContainer(
  node: ContainerNode,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string,
  catalogByKind: ReadonlyMap<string, CatalogEntry>,
  findings: Finding[]
): Layout {
  // Each compiled child is paired with the SOURCE node it came from, because a grid needs the
  // child's own `span` to wrap it in a `GridCell` and the compiled Widget/Layout no longer
  // carries one. A child that compiled to `undefined` (unresolvable, no contract) is skipped —
  // its finding was already recorded.
  const compiled: Array<{ from: ExperienceNode; child: Widget | Layout }> = [];
  for (const child of node.children) {
    const out = compileNode(child, opts, resolveLabel, catalogByKind, findings);
    if (out !== undefined) compiled.push({ from: child, child: out });
  }
  if (node.direction === "grid")
    return grid({
      columns: 12,
      ...(node.gap !== undefined && { gap: node.gap }),
      children: compiled.map(({ from, child }) => cell(from.span, child)),
    });
  // Neither `flex` nor `stack` has columns for a span to occupy (loom ADR 0097 D5), so a child's
  // span is simply not a fact about a flex row — it is not dropped, it does not apply.
  return flex({
    direction: node.direction,
    ...(node.gap !== undefined && { gap: node.gap }),
    children: compiled.map(({ child }) => child),
  });
}

function compileNode(
  node: ExperienceNode,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string,
  catalogByKind: ReadonlyMap<string, CatalogEntry>,
  findings: Finding[]
): Widget | Layout | undefined {
  if (node.kind === "container")
    return compileContainer(node, opts, resolveLabel, catalogByKind, findings);
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
  const ownEntry = findEntry(opts.catalog, node.type, node.typeVersion);
  const ownProps = new Set(ownEntry?.props ?? []);
  // Text props the node's OWN type declares may hold a `LocalizedText`; they resolve here, at
  // compile, exactly like `label` — the locale is a compile input, never a renderer lookup.
  const textProps = new Set(ownEntry?.textProps ?? []);
  const filtered = Object.fromEntries(
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
  // Key ORDER is part of the output bytes (`JSON.stringify` walks insertion order), and
  // `node.props` carries whatever order its author happened to write. Two structurally equal
  // experiences must compile to byte-identical blueprints — that is the whole claim of a
  // deterministic compiler — so the emitted props are rebuilt in sorted key order.
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(filtered).sort())
    props[key] = textProps.has(key) ? resolveText(filtered[key], resolveLabel) : filtered[key];
  // `via` starts with the node's OWN type key, so everything after it is the chain that had to be
  // walked to reach `r.kind` — outermost first, which is the order loom's `degradedFrom` declares.
  const degradedFrom = r.via.slice(1).map((key) => {
    const at = key.lastIndexOf("@");
    return { type: key.slice(0, at), version: key.slice(at + 1) };
  });
  // `customWidget$` is loom's builder and takes no `source`; it is spread and the two structural
  // fields added, rather than reaching into loom to widen a config this compiler happens to need.
  return {
    ...customWidget$({
      kind: r.kind,
      id: node.id,
      ...(node.label !== undefined && { title: resolveLabel(node.label) }),
      props,
    }),
    source: {
      type: node.type,
      version: node.typeVersion,
      ...(degradedFrom.length > 0 && { degradedFrom }),
    },
    ...(node.binding !== undefined && {
      binding: {
        projectionId: opts.hydrationProjectionId,
        path: hydrationPath(node.binding.handle),
        status: { path: hydrationStatusPath(node.binding.handle) },
        ...(node.binding.sensitivity !== undefined && { sensitivity: node.binding.sensitivity }),
      },
    }),
  };
}

/** A `LocalizedText` resolves through `resolveLabel`; anything else (a plain string) passes through. */
function resolveText(value: unknown, resolveLabel: (l: LocalizedText) => string): unknown {
  const parsed = LocalizedText.safeParse(value);
  return parsed.success ? resolveLabel(parsed.data) : value;
}
