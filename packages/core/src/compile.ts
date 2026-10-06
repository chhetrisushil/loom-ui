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
  isLayoutRole,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import {
  type SemanticCatalog,
  type Surface,
  findEntry,
  resolveSurface,
  validateExperience,
} from "./catalog";
import type { DeclaredToolClasses, UndeclaredToolPolicy } from "./classes";
import type { Experience, Finding } from "./experience";
import { experienceHandles } from "./handles";
import { loomCatalogFor } from "./loomCatalog";
import {
  type ContainerNode,
  type ExperienceNode,
  GRID_COLUMNS,
  LocalizedText,
  MAX_TREE_DEPTH,
  compareSiblings,
  normalize,
  placementOf,
  placementProblems,
  treeDepth,
} from "./node";

// ── Experience → loom Blueprint ───────────────────────────────────────────────
// Pure and deterministic: same inputs, byte-identical output. A semantic node becomes a loom
// Widget whose `id` IS the node id (so a WidgetAction maps straight back), whose `kind` is the
// surface resolution, whose `source` records the semantic type and the degrade chain that reached
// that kind, and whose binding points at the hydration projection's `values.<handle>` with
// `status.<handle>` as its status channel. A node's `span` — and, since Blueprint IR 2.1.0, its
// `row`/`rowSpan`/`column` — ride in the `GridCell` its parent grid wraps it in, and a
// container's `title` becomes its compiled layout's title (loom ADR 0098), its `role` its
// layout's role (IR 2.2.0, loom ADR 0099), and its `id` its layout's id (IR 2.4.0, loom ADR
// 0101). Nothing semantic is smuggled into props: the experience is the source of truth, the
// blueprint derived.

import { hydrationPath, hydrationStatusPath } from "./paths";
import { type ProjectionCatalog, type ProjectionPlan, planProjectionBindings } from "./projections";
import { type Viewer, mayView } from "./viewer";
export {
  HYDRATION_STATUS_PREFIX,
  HYDRATION_VALUES_PREFIX,
  hydrationPath,
  hydrationStatusPath,
} from "./paths";

export interface CompileOptions {
  readonly surface: Surface;
  readonly catalog: SemanticCatalog;
  readonly hydrationProjectionId: string;
  readonly hydrationProjectionVersion: string;
  /**
   * The projections the host offers beyond hydration (see `projections.ts`). A node's
   * `projection` binding compiles only against an entry here, at the version it pins; absent, no
   * projection binding compiles (fail-closed) — each is `projection-unknown`. The compiled
   * Blueprint declares only the projections a node the viewer may see binds, each with its pinned
   * version in `projectionVersions` (loom ADR 0095).
   */
  readonly projections?: ProjectionCatalog;
  /**
   * The host's DECLARED class per tool (`toolKey`: the MCP tool name, or `<kind>:<name>`), applied
   * at read time as a floor under every handle calling that tool — see `DeclaredToolClasses`.
   * Absent = only what the experience itself carries.
   */
  readonly declaredToolClasses?: DeclaredToolClasses;
  /**
   * What a tool the `declaredToolClasses` table does not list reads as: `"allow"` (default) = as the
   * experience itself says; `"deny"` = unreadable by every viewer. Only with a table present.
   */
  readonly undeclared?: UndeclaredToolPolicy;
  /** Default: the label's fallback text. */
  readonly resolveLabel?: (label: LocalizedText) => string;
  /** Base loom catalogue for built-in kinds; default `builtinCatalog`. */
  readonly baseCatalog?: WidgetCatalog;
  /** If given, kinds the derived catalogue declares but this registry lacks become `renderer-coverage` findings. */
  readonly registry?: RendererRegistry<unknown>;
  /**
   * Overrides the compiled Blueprint's `title`. Absent (default): `exp.intent.objective`
   * verbatim, today's behaviour, unchanged — but note that the objective is the experience's own
   * compose request, inside its content hash, and can be private; an app that serves the
   * Blueprint to a viewer other than the one who composed it, or that has its own renamable,
   * localizable display title, should override this. A `LocalizedText` resolves through
   * `resolveLabel` exactly like a container title or a node label — same resolver, same locale,
   * same fallback. `{ omit: true }` drops it: loom's Blueprint requires `title` as a string, so
   * this compiles to `""`, which every renderer treats as untitled (loom ADR 0098 D4;
   * `DomRenderOptions.title: "none"` on the web).
   *
   * An explicit override is the app's own text and is never gated. The DEFAULT is gated: when
   * `intent.sensitivity` is set and `viewer` may not see that class, the default is `""`
   * (untitled) instead of the objective.
   */
  readonly title?: LocalizedText | { readonly omit: true };
  /**
   * Who the Blueprint is for (see `viewer.ts`). A semantic node whose binding handle is classified
   * above the viewer's clearance is REDACTED: it compiles to a static `Note` placeholder with the
   * same id, the same grid cell and a neutral "restricted" text, carrying no binding, props,
   * label, type or handle of the node it replaces. Layout and ids are unchanged, so a renderer
   * keeps its place and a recompose still lines up. FAIL-CLOSED: absent = a viewer with no
   * clearance, so every classified binding is redacted (and one `viewer-not-supplied` warn says
   * so); unclassified nodes are never affected. Pass `{ clearance: "secret" }` for full access.
   * The Experience itself is unredacted — compile for a restricted viewer on the trusted side.
   */
  readonly viewer?: Viewer;
  /** The placeholder's title and text. Default: `{ key: "restricted", fallback: "Restricted" }`. */
  readonly restrictedLabel?: LocalizedText;
}

/** The default `CompileOptions.restrictedLabel`. */
export const RESTRICTED_LABEL: LocalizedText = { key: "restricted", fallback: "Restricted" };

export interface CompileResult {
  readonly blueprint: Blueprint;
  readonly findings: readonly Finding[];
  /** True iff there are no error-severity findings. The blueprint is produced either way, so a caller can degrade. */
  readonly ok: boolean;
  /**
   * Ids of the projection-bound nodes compiled to the restricted placeholder for this viewer
   * (restricted, unknown or version-drifted), sorted. Feed it to `compileFingerprint` so a change
   * in what the viewer is denied moves the stamp.
   */
  readonly restrictedProjectionNodes: readonly string[];
  /**
   * The handles redacted for this viewer (their stored class, or the host's `declaredToolClasses`
   * floor, is above the viewer's clearance), sorted. Feed it to `compileFingerprint` as
   * `restrictedHandles`: a RAISED declaration changes what a viewer sees without changing the
   * experience, so a stamp that omits it stays "fresh" over a now-stale view.
   */
  readonly restrictedHandles: readonly string[];
}

export function compile(exp: Experience, opts: CompileOptions): CompileResult {
  const findings: Finding[] = [];
  // Resolved once, ahead of the depth probe below, so the title override applies identically on
  // both the early "too deep" return and the normal path — it is a function of `opts` and `exp`,
  // never of the (possibly-capped) tree.
  const resolveLabel = opts.resolveLabel ?? ((l: LocalizedText) => l.fallback);
  const title = resolveBlueprintTitle(exp, opts, resolveLabel);
  if (title.leakAvoided)
    findings.push({
      code: "title-restricted",
      severity: "warn",
      message: "the default title (the intent objective) is classified above this viewer; omitted",
    });
  // Before `validateExperience`, `normalize` or any recursive descent: a tree past the cap is a
  // finding with an empty blueprint, never a `RangeError` thrown out of a total function.
  const depth = treeDepth(exp.root);
  if (depth > MAX_TREE_DEPTH) {
    return {
      blueprint: blueprint$({
        id: `${exp.experienceId}@${exp.versionHash || "unsealed"}`,
        title: title.text,
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
      restrictedProjectionNodes: [],
      restrictedHandles: [],
    };
  }
  const semantic = validateExperience(exp, opts.catalog, opts.surface);
  findings.push(...semantic.findings);
  const derived = loomCatalogFor(opts.catalog, opts.surface, opts.baseCatalog);
  findings.push(...derived.findings);
  // The strictest class of each handle (a handle carries one value for every node that binds it),
  // read once; a handle the viewer may not see is restricted for EVERY node that binds it.
  const restrictedHandles = new Set<string>();
  let classified = false;
  for (const use of experienceHandles(exp, opts.declaredToolClasses, opts.undeclared)) {
    if (use.sensitivity === undefined) continue;
    classified = true;
    if (!mayView(opts.viewer, use.sensitivity)) restrictedHandles.add(use.handle);
  }
  const projectionPlan = planProjectionBindings(
    exp,
    opts.projections,
    opts.hydrationProjectionId,
    opts.viewer
  );
  findings.push(...projectionPlan.findings);
  if (projectionPlan.classified) classified = true;
  const restrictedNodes = [...projectionPlan.verdicts.values()].some(
    (v) => v.kind === "restricted"
  );
  if (classified && opts.viewer === undefined)
    findings.push({
      code: "viewer-not-supplied",
      severity: "warn",
      message:
        "the experience has classified bindings and no viewer was supplied: they are redacted (no viewer is the most restrictive viewer)",
    });
  const loomCatalog =
    (restrictedHandles.size > 0 || restrictedNodes) &&
    !derived.catalog.entries.some((e) => e.kind === PLACEHOLDER_KIND)
      ? {
          ...derived.catalog,
          entries: [
            ...derived.catalog.entries,
            { kind: PLACEHOLDER_KIND, props: ["text"], binding: "none" as const },
          ],
        }
      : derived.catalog;
  const catalogByKind = new Map(loomCatalog.entries.map((e) => [e.kind, e] as const));
  // The placeholder says "restricted" in the kind's `text` prop where the catalogue declares one
  // (both renderers draw it); a catalogue whose `Note` declares no props still gets the title,
  // and one warn that a host-chrome renderer will show an empty body.
  const placeholderHasText = (catalogByKind.get(PLACEHOLDER_KIND)?.props ?? []).includes("text");
  if ((restrictedHandles.size > 0 || restrictedNodes) && !placeholderHasText)
    findings.push({
      code: "restricted-placeholder-no-text",
      severity: "warn",
      message: `the catalogue's "${PLACEHOLDER_KIND}" declares no "text" prop: a restricted node is drawn with its title only`,
    });
  const redaction: Redaction = {
    handles: restrictedHandles,
    label: opts.restrictedLabel ?? RESTRICTED_LABEL,
    text: placeholderHasText,
    projections: projectionPlan,
  };

  const layout = compileContainer(
    normalize(exp.root, compareSiblings) as ContainerNode,
    opts,
    resolveLabel,
    catalogByKind,
    findings,
    redaction
  );
  const blueprint = blueprint$({
    id: `${exp.experienceId}@${exp.versionHash || "unsealed"}`,
    title: title.text,
    layout,
    ...declaredProjections(opts, projectionPlan),
  });

  // loom's own check, against the framework's catalogue: a compiler defect that emits an
  // off-catalogue kind or an undeclared prop is caught here rather than trusted.
  const loomReport = validateBlueprint(blueprint, loomCatalog);
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
    const cov = catalogCoverage(loomCatalog, opts.registry);
    for (const kind of cov.missing)
      findings.push({
        code: "renderer-coverage",
        severity: "error",
        message: `no renderer registered for "${kind}" (declared by ${loomCatalog.id})`,
      });
  }
  const restrictedProjectionNodes = [...projectionPlan.verdicts.entries()]
    .filter(([, v]) => v.kind === "restricted")
    .map(([id]) => id)
    .sort();
  return {
    blueprint,
    findings,
    ok: findings.every((f) => f.severity !== "error"),
    restrictedProjectionNodes,
    restrictedHandles: [...restrictedHandles].sort(),
  };
}

/**
 * The compiled Blueprint's `title`: `opts.title` when given (a `LocalizedText`, resolved through
 * `resolveLabel` like any other label; `{ omit: true }`, which loom's `title: string` renders as
 * `""`), else `exp.intent.objective` — unless the intent is classified above the viewer, when it
 * is `""` and `leakAvoided` says the default was withheld.
 */
function resolveBlueprintTitle(
  exp: Experience,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string
): { text: string; leakAvoided: boolean } {
  if (opts.title !== undefined)
    return { text: "omit" in opts.title ? "" : resolveLabel(opts.title), leakAvoided: false };
  if (!mayView(opts.viewer, exp.intent.sensitivity)) return { text: "", leakAvoided: true };
  return { text: exp.intent.objective, leakAvoided: false };
}

/**
 * `projections` + `projectionVersions` for the Blueprint: the hydration projection first (exactly
 * as before — an experience with no projection binding compiles byte-identically), then every
 * projection a visible node binds, sorted by id. `Object.fromEntries` so a hostile id such as
 * "__proto__" lands as an own key, never the prototype setter.
 */
function declaredProjections(
  opts: CompileOptions,
  plan: ProjectionPlan
): { projections: string[]; projectionVersions: Record<string, string> } {
  const extra = [...plan.used.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    projections: [opts.hydrationProjectionId, ...extra.map(([id]) => id)],
    projectionVersions: Object.fromEntries([
      [opts.hydrationProjectionId, opts.hydrationProjectionVersion],
      ...extra,
    ]),
  };
}

/** The static kind a redacted node compiles to: unbound, one `text` prop, drawn by every renderer. */
const PLACEHOLDER_KIND = "Note";

interface Redaction {
  readonly handles: ReadonlySet<string>;
  readonly label: LocalizedText;
  /** Whether the placeholder kind's contract declares the `text` prop. */
  readonly text: boolean;
  readonly projections: ProjectionPlan;
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
  findings: Finding[],
  redaction: Redaction
): Layout {
  // Each compiled child is paired with the SOURCE node it came from, because a grid needs the
  // child's own `span` and placement to wrap it in a `GridCell` and the compiled Widget/Layout no
  // longer carries one. A child that compiled to `undefined` (unresolvable, no contract) is
  // skipped — its finding was already recorded.
  const compiled: Array<{ from: ExperienceNode; child: Widget | Layout }> = [];
  for (const child of node.children) {
    const out = compileNode(child, opts, resolveLabel, catalogByKind, findings, redaction);
    if (out !== undefined) compiled.push({ from: child, child: out });
  }
  // A container title resolves like a label: the locale is a compile input, and the blueprint
  // carries display text, never a message key. An empty resolution is no heading at all — every
  // renderer draws only a non-empty title (loom ADR 0098 D4) — so no key is emitted for it.
  const title = node.title !== undefined ? resolveLabel(node.title) : "";
  const titled = title !== "" ? { title } : {};
  // A role (IR 2.2.0, loom ADR 0099) is copied as-is — it is a registry key, not display text, so
  // nothing resolves it. A malformed one was reported against the node by `validateExperience`
  // (`role-invalid`, warn) and is NOT emitted: every renderer would draw the plain container
  // anyway, and loom's `validateBlueprint` would repeat the finding against "<layout>".
  const roled = isLayoutRole(node.role) ? { role: node.role } : {};
  // An id (IR 2.4.0, loom ADR 0101) is the container's node id — the same identity the
  // Experience already addresses it by, in the one namespace widget ids share — so a renderer can
  // keep the container (and every widget under it) across a recompose that inserts or reorders
  // containers. loom-ui's `NodeId` rule (a non-empty string) IS loom's `isLayoutId`. A malformed
  // id (a hand-built node that bypassed the schema) is passed through ON PURPOSE: loom's
  // validateBlueprint pass below reports it as `loom:layout-id-invalid` (warn), and every renderer
  // treats it as absent (keyed positionally) — dropping it here would lose it with no finding.
  const identified = node.id !== undefined ? { id: node.id } : {};
  if (node.direction === "grid")
    return grid({
      ...identified,
      columns: GRID_COLUMNS,
      ...(node.gap !== undefined && { gap: node.gap }),
      ...titled,
      ...roled,
      // A placement `validateExperience` reported as off-grid is NOT emitted: the node still
      // renders, at flow placement, and the error is reported once, against the node. Emitting it
      // would hand every renderer a position it cannot draw and make loom's validateBlueprint
      // repeat the finding against "<layout>" for a container cell.
      children: compiled.map(({ from, child }) =>
        cell(from.span, child, placementProblems(from).length === 0 ? placementOf(from) : {})
      ),
    });
  // Neither `flex` nor `stack` has columns for a span or a placement to occupy (loom ADR 0097 D5).
  // A span simply does not apply here; a placement is `placement-outside-grid` (validateExperience).
  return flex({
    ...identified,
    direction: node.direction,
    ...(node.gap !== undefined && { gap: node.gap }),
    ...titled,
    ...roled,
    children: compiled.map(({ child }) => child),
  });
}

function compileNode(
  node: ExperienceNode,
  opts: CompileOptions,
  resolveLabel: (l: LocalizedText) => string,
  catalogByKind: ReadonlyMap<string, CatalogEntry>,
  findings: Finding[],
  redaction: Redaction
): Widget | Layout | undefined {
  if (node.kind === "container")
    return compileContainer(node, opts, resolveLabel, catalogByKind, findings, redaction);
  // Before resolution, props, label or binding are read: a restricted node contributes NOTHING of
  // its own to the output but its id (and, in the parent, its cell), so it can neither leak nor
  // reflow its neighbours.
  const verdict = redaction.projections.verdicts.get(node.id);
  // A projection-bound node the plan refused was reported (by the plan or `validateExperience`)
  // and is omitted, like an unresolvable node: never faked.
  if (verdict?.kind === "refused") return undefined;
  if (
    verdict?.kind === "restricted" ||
    (node.binding !== undefined && redaction.handles.has(node.binding.handle))
  ) {
    findings.push({
      code: "node-restricted",
      severity: "warn",
      message: `node "${node.id}" is restricted for this viewer`,
      nodeId: node.id,
    });
    const text = resolveLabel(redaction.label);
    return customWidget$({
      kind: PLACEHOLDER_KIND,
      id: node.id,
      title: text,
      props: redaction.text ? { text } : {},
    });
  }
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
    ...(verdict?.kind === "ok" && {
      binding: {
        projectionId: verdict.binding.id,
        path: verdict.binding.path,
        ...(verdict.binding.statusPath !== undefined && {
          status: { path: verdict.binding.statusPath },
        }),
        ...(verdict.sensitivity !== undefined && { sensitivity: verdict.sensitivity }),
      },
    }),
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
