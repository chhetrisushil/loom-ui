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
import type { DataClass } from "@loom/classify";
import {
  type SemanticCatalog,
  type Surface,
  findEntry,
  resolveSurface,
  validateExperience,
} from "./catalog";
import type { DeclaredToolClasses, UndeclaredToolPolicy } from "./classes";
import { type CompileMemo, defaultCompileMemo } from "./compileMemo";
import type { Experience, Finding } from "./experience";
import { experienceHandles } from "./handles";
import { loomCatalogFor } from "./loomCatalog";
import {
  type ContainerNode,
  type ExperienceNode,
  GRID_COLUMNS,
  LocalizedText,
  MAX_TREE_DEPTH,
  normalize,
  placementOf,
  placementProblems,
  treeDepth,
  walk,
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

import {
  type AliasDomain,
  type AliasKey,
  PlaceholderKeyError,
  derive,
  resolveAliasKey,
} from "./alias";
import { hydrationPath, hydrationStatusPath } from "./paths";
import { type ProjectionCatalog, type ProjectionPlan, planProjectionBindings } from "./projections";
import { type Audience, type Viewer, effectiveViewer, isBroadcast, mayView } from "./viewer";
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
   *
   * The placeholder's id is an OPAQUE ALIAS, never the node's own (ids are lexical and say what a
   * hidden node is about): see `placeholderKey`. Its grid cell is unchanged.
   */
  readonly viewer?: Viewer;
  /**
   * WHO the surface is for (slice 7): `"viewer"` (default) = the requesting `viewer`, exactly as
   * before. `"broadcast"` = a surface many or unknown viewers see at once (a wallboard, a shared
   * screen): the effective clearance is the STRICTER of the viewer's and the broadcast ceiling, and
   * the ceiling is the lowest class (UNCLASSIFIED content only), so every classified binding is
   * withheld whoever asked, and an unrecognised class fails closed (withheld). The `viewer` is then
   * used only to tell the two reasons apart in the (server-side) findings: `audience-withheld` (the
   * viewer could see it, the audience may not) vs `node-restricted` (the viewer could not either).
   *
   * Every node withheld on a broadcast surface compiles to ONE shape, the loom IR 2.5.0 redacted
   * widget: kind `Note`, `source: { type: "redacted", version: "1", redacted: true }`, an opaque
   * `r_` alias id, the same grid cell, and no binding, title, props, degrade chain or original
   * type, so the artifact says nothing of what was withheld nor which reason applied. (On a
   * `"viewer"` surface the restricted placeholder is unchanged: a `Note` reading "Restricted".)
   * The Blueprint has no `audience` field (loom ADR 0097 D5); it records the RESULT. Anything but
   * `undefined` / `"viewer"` is read as broadcast (fail-closed). An explicit `title` override is the
   * app's own text and is never gated, as for a viewer.
   */
  readonly audience?: Audience;
  /**
   * A secret the HOST holds (at least 16 bytes; a string is UTF-8). A restricted placeholder, and a
   * container collapsed over nothing but placeholders, is emitted under `r_` + a keyed hash
   * (HMAC-SHA256) of `(experienceId, nodeId)`: stable across versions and compiles with the same
   * key (so a renderer reconciles it in place), different per experience, and not recoverable or
   * confirmable without the key. FAIL-CLOSED: ABSENT = a random per-process key (confidentiality
   * intact; aliases AND `fingerprint` change on restart or between replicas, so actions stamped
   * before are refused as stale) and one `placeholder-alias-key-not-supplied` warn when an alias was
   * needed. A SUPPLIED key under 16 bytes throws `PlaceholderKeyError` (never a silent random key).
   * Never an unkeyed hash. Unrestricted nodes keep their own ids.
   */
  readonly placeholderKey?: AliasKey;
  /**
   * Production setting: with no `placeholderKey`, compiling anything that needs an alias (a
   * restricted node, a collapsed container, a non-empty `fingerprint`) throws `PlaceholderKeyError`
   * instead of falling back to the random per-process key. Default false.
   */
  readonly requirePlaceholderKey?: boolean;
  /** The placeholder's title and text. Default: `{ key: "restricted", fallback: "Restricted" }`. */
  readonly restrictedLabel?: LocalizedText;
  /**
   * Names what a custom `resolveLabel` returns (e.g. the locale and bundle revision), so the
   * compile memo may reuse a result: two calls with the same key MUST resolve every label alike.
   * A custom `resolveLabel` without it is never memoized; the default resolver needs none.
   */
  readonly resolveLabelKey?: string;
  /**
   * The per-version memo (see `compileMemo.ts`): `undefined` = the shared default (a small LRU),
   * `false` = off, a `CompileMemo` = your own. Only a SEALED experience is memoized; every result
   * is a private copy, so mutating one never reaches another caller.
   */
  readonly memo?: CompileMemo | false;
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
  /**
   * The EFFECTIVE viewer this surface was compiled for (`effectiveViewer(opts.viewer, opts.audience)`):
   * the requesting viewer on a viewer surface, a viewer with no clearance on a broadcast one. Pass
   * it (not the requesting viewer) to `describeChange`, `snapshotSeen`, `explainNode` and the
   * lineage / seen-log reads so a broadcast surface's companions never judge by the asker.
   */
  readonly viewer: Viewer;
  /**
   * `viewer.clearance`: feed THIS (not the requesting viewer's) to `compileFingerprint`, so a
   * broadcast stamp is the same whoever asked.
   */
  readonly clearance: DataClass | undefined;
  /**
   * The two lists above as OPAQUE aliases (same keyed hash as the placeholder ids), sorted. `findings`,
   * `restrictedProjectionNodes` and `restrictedHandles` are SERVER-SIDE: they name real node ids and
   * handles. `compileFingerprint` is hashed into a stamp the VIEWER carries (and its hash is not
   * secret), so feed it these instead — `compileFingerprint({ clearance: result.clearance, locale, ...result.fingerprint })`
   * — or a viewer can confirm a guessed handle against its own stamp.
   */
  readonly fingerprint: {
    readonly restrictedHandles: readonly string[];
    readonly restrictedProjectionNodes: readonly string[];
    /**
     * The ids (aliases) of every node drawn as a bare restricted placeholder, sorted. The viewer
     * already holds them (they are the placeholders' ids in the Blueprint); a signal collector
     * (`@loom-ui/core/signals`) takes them so it reports such a node as restricted, never by content.
     */
    readonly placeholderNodes: readonly string[];
  };
}

export function compile(exp: Experience, opts: CompileOptions): CompileResult {
  const memo = opts.memo === false ? undefined : (opts.memo ?? defaultCompileMemo);
  const key = memo?.keyOf(exp, opts);
  if (memo === undefined || key === undefined) return compileUncached(exp, opts);
  const hit = memo.get(key, exp);
  if (hit !== undefined) return hit;
  const result = compileUncached(exp, opts); // a throw (PlaceholderKeyError) is never remembered
  memo.set(key, exp, result);
  return result;
}

function compileUncached(exp: Experience, opts: CompileOptions): CompileResult {
  const findings: Finding[] = [];
  // Resolved once, ahead of the depth probe below, so the title override applies identically on
  // both the early "too deep" return and the normal path — it is a function of `opts` and `exp`,
  // never of the (possibly-capped) tree.
  const resolveLabel = opts.resolveLabel ?? ((l: LocalizedText) => l.fallback);
  const broadcast = isBroadcast(opts.audience);
  // The viewer whose clearance decides the surface: the requesting one, or (broadcast) none.
  const viewer = effectiveViewer(opts.viewer, opts.audience);
  const title = resolveBlueprintTitle(exp, opts, resolveLabel, viewer);
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
      fingerprint: { restrictedHandles: [], restrictedProjectionNodes: [], placeholderNodes: [] },
      viewer: viewer ?? {},
      clearance: viewer?.clearance,
    };
  }
  const semantic = validateExperience(exp, opts.catalog, opts.surface);
  findings.push(...semantic.findings);
  const derived = loomCatalogFor(opts.catalog, opts.surface, opts.baseCatalog);
  findings.push(...derived.findings);
  // The strictest class of each handle (a handle carries one value for every node that binds it),
  // read once; a handle the viewer may not see is restricted for EVERY node that binds it.
  const restrictedHandles = new Set<string>();
  // Broadcast only: the handles the requesting viewer COULD see but the audience may not.
  const audienceHandles = new Set<string>();
  let classified = false;
  for (const use of experienceHandles(exp, opts.declaredToolClasses, opts.undeclared)) {
    if (use.sensitivity === undefined) continue;
    classified = true;
    if (!mayView(viewer, use.sensitivity)) {
      restrictedHandles.add(use.handle);
      if (broadcast && mayView(opts.viewer, use.sensitivity)) audienceHandles.add(use.handle);
    }
  }
  const projectionPlan = planProjectionBindings(
    exp,
    opts.projections,
    opts.hydrationProjectionId,
    viewer
  );
  findings.push(...projectionPlan.findings);
  // The same plan for the requesting viewer (its findings are dropped: they repeat the plan's),
  // only to name WHY a projection-bound node is withheld.
  const audienceNodes = new Set<string>();
  if (broadcast) {
    const asked = planProjectionBindings(
      exp,
      opts.projections,
      opts.hydrationProjectionId,
      opts.viewer
    );
    for (const [id, v] of projectionPlan.verdicts)
      if (v.kind === "restricted" && asked.verdicts.get(id)?.kind === "ok") audienceNodes.add(id);
  }
  if (projectionPlan.classified) classified = true;
  const restrictedNodes = [...projectionPlan.verdicts.values()].some(
    (v) => v.kind === "restricted"
  );
  if (classified && opts.viewer === undefined && !broadcast)
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
  if ((restrictedHandles.size > 0 || restrictedNodes) && !placeholderHasText && !broadcast)
    findings.push({
      code: "restricted-placeholder-no-text",
      severity: "warn",
      message: `the catalogue's "${PLACEHOLDER_KIND}" declares no "text" prop: a restricted node is drawn with its title only`,
    });
  const redaction: Redaction = {
    handles: restrictedHandles,
    broadcast,
    audienceHandles,
    audienceNodes,
    label: opts.restrictedLabel ?? RESTRICTED_LABEL,
    text: placeholderHasText,
    projections: projectionPlan,
    bare: new WeakSet<object>(),
    alias: aliasMinter(exp, opts, findings),
  };

  const compiledRoot = compileContainer(
    // Ties on `order` keep their authored order here; `compileContainer` breaks them on the EMITTED
    // id, so a hidden node's real id never decides where it sits among its siblings.
    normalize(exp.root) as ContainerNode,
    opts,
    resolveLabel,
    catalogByKind,
    findings,
    redaction
  );
  // A root collapsed to a bare placeholder is still a Layout: a plain column holding just that
  // placeholder, with no title, role, id or direction of the root's own.
  const layout: Layout = redaction.bare.has(compiledRoot)
    ? flex({ direction: "column", children: [compiledRoot] })
    : (compiledRoot as Layout);
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
  const opaque = (ids: readonly string[], domain: AliasDomain): string[] =>
    ids.map((id) => redaction.alias.of(id, domain)).sort();
  return {
    blueprint,
    findings,
    ok: findings.every((f) => f.severity !== "error"),
    restrictedProjectionNodes,
    restrictedHandles: [...restrictedHandles].sort(),
    viewer: viewer ?? {},
    clearance: viewer?.clearance,
    fingerprint: {
      restrictedHandles: opaque([...restrictedHandles], "handle"),
      restrictedProjectionNodes: opaque(restrictedProjectionNodes, "node"),
      placeholderNodes: placeholderIdsOf(layout, redaction.bare),
    },
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
  resolveLabel: (l: LocalizedText) => string,
  viewer: Viewer | undefined
): { text: string; leakAvoided: boolean } {
  if (opts.title !== undefined)
    return { text: "omit" in opts.title ? "" : resolveLabel(opts.title), leakAvoided: false };
  if (!mayView(viewer, exp.intent.sensitivity)) return { text: "", leakAvoided: true };
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
  /** A broadcast surface: every withheld node is the IR 2.5.0 redacted widget. */
  readonly broadcast: boolean;
  /** Broadcast: handles / projection-bound node ids the requesting viewer could see (finding reason only). */
  readonly audienceHandles: ReadonlySet<string>;
  readonly audienceNodes: ReadonlySet<string>;
  readonly label: LocalizedText;
  /** Whether the placeholder kind's contract declares the `text` prop. */
  readonly text: boolean;
  readonly projections: ProjectionPlan;
  /**
   * The compiled outputs that are BARE placeholders (a restricted node, or a container collapsed
   * over nothing but bare placeholders). Identity-keyed: a container collapses iff it has compiled
   * children and every one of them is in here.
   */
  readonly bare: WeakSet<object>;
  /** The opaque ids a redacted node or handle is emitted under. */
  readonly alias: AliasMinter;
}

interface AliasMinter {
  /** The alias of an id, memoised and collision-free against every real node id in the tree. */
  of(id: string, domain?: AliasDomain): string;
}

/**
 * One key resolution per compile. An alias is re-derived (a counter in the hash input) when it
 * would equal any real node id of the experience or another alias — a hostile or unlucky id can
 * never make two widgets share an id. The warn (no usable key) is pushed once, on first use.
 */
function aliasMinter(exp: Experience, opts: CompileOptions, findings: Finding[]): AliasMinter {
  const key = resolveAliasKey(opts.placeholderKey);
  const real = new Set<string>();
  walk(exp.root, (n) => {
    real.add(n.id);
  });
  const memo = new Map<string, string>();
  const taken = new Map<string, string>();
  let warned = false;
  return {
    of(id, domain = "node") {
      const mk = `${domain}\u0000${id}`;
      const hit = memo.get(mk);
      if (hit !== undefined) return hit;
      if (key.source !== "supplied") {
        if (opts.requirePlaceholderKey === true)
          throw new PlaceholderKeyError(
            "placeholder-key-required",
            "requirePlaceholderKey is set and no placeholderKey was supplied, but this compile redacts something"
          );
        if (!warned) {
          warned = true;
          findings.push({
            code: "placeholder-alias-key-not-supplied",
            severity: "warn",
            message:
              "no placeholderKey was supplied: a random per-process key is used, so placeholder aliases and fingerprints differ across replicas and restarts, and actions stamped before are refused as stale",
          });
        }
      }
      let alias = "";
      for (let attempt = 0; ; attempt++) {
        alias = derive(key.bytes, exp.experienceId, id, domain, attempt);
        const owner = taken.get(alias);
        if (!real.has(alias) && (owner === undefined || owner === mk)) break;
      }
      taken.set(alias, mk);
      memo.set(mk, alias);
      return alias;
    },
  };
}

/** The restricted placeholder for `id`: an opaque alias (and, in the parent, the node's cell) and a neutral text. */
function barePlaceholder(
  id: string,
  resolveLabel: (l: LocalizedText) => string,
  redaction: Redaction,
  findings: Finding[],
  forAudience = false
): Widget {
  // The finding is SERVER-SIDE and names the real id; the Blueprint carries only the alias.
  findings.push(
    forAudience
      ? {
          code: "audience-withheld",
          severity: "warn",
          message: `node "${id}" is withheld from this broadcast audience`,
          nodeId: id,
        }
      : {
          code: "node-restricted",
          severity: "warn",
          message: `node "${id}" is restricted for this viewer`,
          nodeId: id,
        }
  );
  if (redaction.broadcast) {
    // IR 2.5.0 (loom ADR 0097 amendment): the generic constants, never the original type; no
    // title, props, binding or degrade chain. One shape for both reasons, so the artifact does not
    // reveal whether the requesting viewer could have seen the node.
    const out: Widget = {
      ...customWidget$({ kind: PLACEHOLDER_KIND, id: redaction.alias.of(id), props: {} }),
      source: { type: "redacted", version: "1", redacted: true },
    };
    redaction.bare.add(out);
    return out;
  }
  const text = resolveLabel(redaction.label);
  const out = customWidget$({
    kind: PLACEHOLDER_KIND,
    id: redaction.alias.of(id),
    title: text,
    props: redaction.text ? { text } : {},
  });
  redaction.bare.add(out);
  return out;
}

/**
 * The ids of the bare placeholders that SURVIVED into the final tree (a placeholder swallowed by a
 * collapsed container is not in it), sorted. Iterative, so a deep tree cannot overflow the stack.
 */
function placeholderIdsOf(root: Layout, bare: WeakSet<object>): string[] {
  const out: string[] = [];
  const stack: Array<Widget | Layout> = [root];
  while (stack.length > 0) {
    const n = stack.pop() as Widget | Layout;
    if ("_tag" in n) {
      if (bare.has(n)) out.push(n.id);
    } else if (n.type === "grid") for (const c of n.children) stack.push(c.node);
    else for (const c of n.children) stack.push(c);
  }
  return out.sort();
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
): Layout | Widget {
  // Each compiled child is paired with the SOURCE node it came from, because a grid needs the
  // child's own `span` and placement to wrap it in a `GridCell` and the compiled Widget/Layout no
  // longer carries one. A child that compiled to `undefined` (unresolvable, no contract) is
  // skipped — its finding was already recorded.
  const compiled: Array<{ from: ExperienceNode; child: Widget | Layout }> = [];
  const findingsBefore = findings.length;
  // A child omitted for any reason OTHER than a projection refusal (unresolvable, no contract):
  // it is not a bare placeholder and not ignorable, so it keeps its container from collapsing.
  let droppedOther = false;
  for (const child of node.children) {
    const out = compileNode(child, opts, resolveLabel, catalogByKind, findings, redaction);
    if (out !== undefined) compiled.push({ from: child, child: out });
    else if (
      !(
        child.kind === "semantic" &&
        redaction.projections.verdicts.get(child.id)?.kind === "refused"
      )
    )
      droppedOther = true;
  }
  // Total sibling order: `order`, then the id the child is EMITTED under (a restricted child's alias,
  // never its real id: the position among tied siblings would otherwise leak a comparison bit of it).
  const emitted = (c: { from: ExperienceNode; child: Widget | Layout }): string =>
    c.child.id ?? c.from.id;
  compiled.sort((x, y) =>
    x.from.order < y.from.order
      ? -1
      : x.from.order > y.from.order
        ? 1
        : emitted(x) < emitted(y)
          ? -1
          : emitted(x) > emitted(y)
            ? 1
            : 0
  );
  // A container whose compiled children are ALL bare placeholders has nothing visible in it for
  // this viewer, so it contributes nothing but its id — exactly like a restricted node: no title,
  // no role, no child count, no per-child placeholders (its own cell in the parent stays). Applies
  // bottom-up, so a container of all-restricted containers collapses too. An EMPTY container (or
  // one whose children were all refused projection bindings) holds nothing restricted and stays as
  // authored; so does one with ANY child omitted for another reason (unresolvable, no contract).
  if (
    !droppedOther &&
    compiled.length > 0 &&
    compiled.every(({ child }) => redaction.bare.has(child))
  ) {
    // The container is ONE restricted node: the `node-restricted` findings of the children it
    // swallowed would name them (and their count), so only its own remains.
    // On a broadcast surface the container is withheld for the audience when any swallowed child was.
    let forAudience = false;
    for (let i = findings.length - 1; i >= findingsBefore; i--) {
      const code = findings[i]?.code;
      if (code === "audience-withheld") forAudience = true;
      if (code === "node-restricted" || code === "audience-withheld") findings.splice(i, 1);
    }
    return barePlaceholder(node.id, resolveLabel, redaction, findings, forAudience);
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
    return barePlaceholder(
      node.id,
      resolveLabel,
      redaction,
      findings,
      redaction.broadcast &&
        (verdict?.kind === "restricted"
          ? redaction.audienceNodes.has(node.id)
          : node.binding !== undefined && redaction.audienceHandles.has(node.binding.handle))
    );
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
