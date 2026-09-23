import type { Experience, Finding, VocabularyFloor } from "./experience";
import {
  type ContainerNode,
  type ExperienceNode,
  LocalizedText,
  MAX_TREE_DEPTH,
  type SemanticNode,
  isPlaced,
  placementProblems,
  roleProblem,
  treeDepth,
  walk,
} from "./node";

// ── The semantic catalogue ────────────────────────────────────────────────────
// An entry is what a planner may NAME. It declares the props it accepts (an allow-list — `[]` is
// a valid answer, declining to answer is not), whether it renders bound data, and how each
// surface MODALITY realises it: a loom widget kind, or a degrade to another entry. Resolution is
// per modality, not per renderer — React and Lit both register `MetricCard`, so one `web`
// compile serves both. The catalogue is extensible at build time and CLOSED at runtime.

export type Surface = "web" | "terminal" | "chat";

/** A loom widget kind plus, for kinds outside loom's builtinCatalog, the contract loom will check against (ADR 0088 D2: both fields, no defaults). */
export interface KindContract {
  readonly kind: string;
  readonly props?: readonly string[];
  readonly binding?: "required" | "optional" | "none";
}
export type SurfaceResolution =
  | KindContract
  | { readonly degradeTo: { readonly name: string; readonly version: string } };

export interface SemanticEntry {
  readonly name: string;
  readonly version: string;
  readonly props: readonly string[];
  readonly binding: "required" | "optional" | "none";
  /**
   * Props whose value is display TEXT: a plain string, or a `LocalizedText`
   * `{ key, fallback }` that `compile` resolves through `resolveLabel` exactly like a node label —
   * so a compiled Blueprint carries display text, never a message key.
   */
  readonly textProps?: readonly string[];
  /**
   * Who may set a binding's confidentiality class on a node of this type: the caller composing
   * the experience (the default, `"caller"`), or a planner proposing one. Declarative only —
   * the compiler carries whatever class the node's binding holds.
   */
  readonly sensitivity?: "caller" | "model-may-set";
  readonly surfaces: Partial<Record<Surface, SurfaceResolution>>;
}
export interface SemanticCatalog {
  readonly id: string;
  readonly entries: readonly SemanticEntry[];
}

export function defineSemanticCatalog(catalog: SemanticCatalog): SemanticCatalog {
  return catalog;
}

/**
 * Order two dotted versions. Numeric segments compare numerically (so `1.2.0 < 1.10.0`);
 * anything else compares as a string. The all-numeric assumption was not safe: `Number("0-beta")`
 * is `NaN`, every comparison against `NaN` is false, and the subtraction returned `NaN` — which
 * `checkFloor`'s `< 0` and `> 0` both read as "no", so a prerelease typeVersion silently satisfied
 * a floor it does not meet. The result is always finite.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

export function findEntry(
  catalog: SemanticCatalog,
  name: string,
  version: string
): SemanticEntry | undefined {
  return catalog.entries.find((e) => e.name === name && e.version === version);
}

// The predicate's asserted type must match the union member EXACTLY (readonly modifiers
// included) or TS's negative narrowing silently fails to exclude it, leaving `res` untyped as
// `KindContract` after the guard (found via `pnpm build`, not the test suite — vitest's esbuild
// transform does not typecheck). `Extract` derives the type from the union itself so it can't drift.
const isDegrade = (r: SurfaceResolution): r is Extract<SurfaceResolution, { degradeTo: unknown }> =>
  "degradeTo" in r;

export type Resolution =
  | { ok: true; kind: string; contract: KindContract; entry: SemanticEntry; via: string[] }
  | { ok: false; finding: Finding };

const finding = (code: string, message: string, nodeId?: string): Finding => ({
  code,
  severity: "error",
  message,
  ...(nodeId !== undefined && { nodeId }),
});

/** Resolve (name, version) on a surface, following degrade chains. Deterministic; a cycle or a dead end is a finding. */
export function resolveSurface(
  catalog: SemanticCatalog,
  name: string,
  version: string,
  surface: Surface,
  nodeId?: string
): Resolution {
  const via: string[] = [];
  const seen = new Set<string>();
  let cur = { name, version };
  for (;;) {
    const key = `${cur.name}@${cur.version}`;
    if (seen.has(key))
      return {
        ok: false,
        finding: finding(
          "degrade-cycle",
          `degrade chain cycles at ${key} on "${surface}" (${via.join(" → ")})`,
          nodeId
        ),
      };
    seen.add(key);
    via.push(key);
    const entry = findEntry(catalog, cur.name, cur.version);
    if (!entry)
      return {
        ok: false,
        finding: finding("unknown-type", `"${key}" is not in catalogue "${catalog.id}"`, nodeId),
      };
    const res = entry.surfaces[surface];
    if (!res)
      return {
        ok: false,
        finding: finding(
          "unresolvable-on-surface",
          `"${key}" has no resolution on "${surface}"`,
          nodeId
        ),
      };
    if (isDegrade(res)) {
      cur = res.degradeTo;
      continue;
    }
    return { ok: true, kind: res.kind, contract: res, entry, via };
  }
}

/** Types the floor requires that the experience does not carry at or above the floor's version. */
export function checkFloor(exp: Experience, floor: VocabularyFloor): Finding[] {
  const present = new Map<string, string>(); // name → highest typeVersion present
  walk(exp.root, (n) => {
    if (n.kind !== "semantic") return;
    const prev = present.get(n.type);
    if (prev === undefined || compareVersions(n.typeVersion, prev) > 0)
      present.set(n.type, n.typeVersion);
  });
  const out: Finding[] = [];
  for (const t of floor.types) {
    const have = present.get(t.name);
    if (have === undefined)
      out.push(
        finding(
          "floor-violation",
          `floor requires "${t.name}@${t.version}" and the experience has no ${t.name}`
        )
      );
    else if (compareVersions(have, t.version) < 0)
      out.push(
        finding(
          "floor-violation",
          `floor requires "${t.name}@${t.version}" but the experience carries ${t.name}@${have}`
        )
      );
  }
  return out;
}

export interface ExperienceValidation {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  /** Semantic nodes visited — `ok` over zero nodes proves nothing, so the denominator rides along (ADR 0088 D3). */
  readonly nodes: number;
}

export function validateExperience(
  exp: Experience,
  catalog: SemanticCatalog,
  surface: Surface
): ExperienceValidation {
  const findings: Finding[] = [];
  // `walk` is recursive; a tree past the cap would throw a `RangeError` out of a function whose
  // whole contract is that a defect is a finding. Probe iteratively first and refuse.
  const depth = treeDepth(exp.root);
  if (depth > MAX_TREE_DEPTH)
    return {
      ok: false,
      findings: [
        finding(
          "tree-too-deep",
          `the experience tree nests ${depth} levels, over the ${MAX_TREE_DEPTH} limit`,
          exp.root.id
        ),
      ],
      nodes: 0,
    };
  const ids = new Set<string>();
  let nodes = 0;
  walk(exp.root, (n, parent) => {
    if (ids.has(n.id))
      findings.push(finding("duplicate-node-id", `node id "${n.id}" appears more than once`, n.id));
    ids.add(n.id);
    checkPlacement(n, parent, findings);
    if (n.kind !== "semantic") {
      checkRole(n, findings);
      return;
    }
    nodes++;
    checkSemantic(n, exp, catalog, surface, findings);
  });
  findings.push(...checkFloor(exp, exp.vocabularyFloor));
  return { ok: findings.every((f) => f.severity !== "error"), findings, nodes };
}

/**
 * A node's placement (loom ADR 0098) is a position in its PARENT's grid. Under a `grid` container
 * it must fit the compiled grid's `GRID_COLUMNS` — `placement-out-of-range`, loom's own predicate
 * and code, reported here against the NODE (loom's copy of the finding cannot name a container
 * cell's node). Anywhere else there is no grid to place it in — a row/column parent compiles to a
 * flex layout with no grid lines, and the root IS the blueprint's layout, not a cell — so it is
 * `placement-outside-grid`. Both are errors: unlike `span`, which every node must carry and which
 * therefore simply does not apply outside a grid (loom ADR 0097 D5), a placement is only ever
 * written on purpose, and dropping it would draw the node somewhere its author did not ask.
 */
function checkPlacement(
  n: ExperienceNode,
  parent: ContainerNode | null,
  findings: Finding[]
): void {
  if (!isPlaced(n)) return;
  if (parent === null || parent.direction !== "grid") {
    const keys = (["row", "rowSpan", "column"] as const).filter((k) => n[k] !== undefined);
    const where =
      parent === null
        ? "it is the root, which is not a grid cell"
        : `its parent "${parent.id}" is a ${parent.direction}, not a grid`;
    findings.push(
      finding(
        "placement-outside-grid",
        `"${n.id}" sets ${keys.join(", ")} but ${where} — there are no grid lines to place it on`,
        n.id
      )
    );
    return;
  }
  const problems = placementProblems(n);
  if (problems.length > 0)
    findings.push(
      finding(
        "placement-out-of-range",
        `"${n.id}": placement cannot be laid out — ${problems.join("; ")}`,
        n.id
      )
    );
}

/**
 * A container's role (loom ADR 0099) must be a well-formed key or every renderer silently draws
 * the plain container. loom's `validateBlueprint` reports that as `role-invalid` against
 * `"<layout>"`; reported here with the same code and severity against the NODE, and `compile`
 * then leaves the role off so loom's copy never fires. A WARN, as in loom (D4): nothing is lost
 * but the custom rendering. A well-formed role no renderer knows is not a finding — which roles
 * are registered is a fact about the renderer in use, not the experience.
 */
function checkRole(n: ContainerNode, findings: Finding[]): void {
  const problem = roleProblem(n);
  if (problem !== undefined)
    findings.push({
      code: "role-invalid",
      severity: "warn",
      message: `"${n.id}": ${problem} — renderers draw the plain container`,
      nodeId: n.id,
    });
}

function checkSemantic(
  n: SemanticNode,
  exp: Experience,
  catalog: SemanticCatalog,
  surface: Surface,
  findings: Finding[]
): void {
  // A binding names a handle; `exp.providers` is what turns a handle into something to fetch. A
  // handle with no spec renders a permanently empty widget and says nothing about why, so it is
  // reported — as a WARN, because the composer may legitimately be mid-composition (bind the node
  // now, remap the provider next op), and because nothing downstream is unsafe: the blueprint's
  // binding path is inert until a projection publishes under it.
  // `hasOwnProperty`, not `in` or a truthiness check: `providers` is a plain record, so a handle
  // spelled "__proto__" or "toString" would otherwise resolve against Object.prototype and the
  // finding would vanish for exactly the inputs most worth flagging.
  if (
    n.binding !== undefined &&
    !Object.prototype.hasOwnProperty.call(exp.providers, n.binding.handle)
  )
    findings.push({
      code: "unknown-handle",
      severity: "warn",
      message: `"${n.id}" binds handle "${n.binding.handle}", which this experience does not provide`,
      nodeId: n.id,
    });
  const entry = findEntry(catalog, n.type, n.typeVersion);
  if (!entry) {
    findings.push(
      finding(
        "unknown-type",
        `"${n.type}@${n.typeVersion}" is not in catalogue "${catalog.id}"`,
        n.id
      )
    );
    return; // no entry → no allow-list, no binding rule; inventing follow-on findings would inflate the rate
  }
  const allowed = new Set(entry.props);
  for (const key of Object.keys(n.props)) {
    if (!allowed.has(key))
      findings.push(
        finding(
          "undeclared-prop",
          `prop "${key}" is not declared by "${n.type}@${n.typeVersion}"`,
          n.id
        )
      );
  }
  for (const key of entry.textProps ?? []) {
    if (!Object.hasOwn(n.props, key)) continue;
    const value = n.props[key];
    if (typeof value !== "string" && !LocalizedText.safeParse(value).success)
      findings.push(
        finding(
          "text-prop-shape",
          `prop "${key}" of "${n.type}@${n.typeVersion}" is text: a string or a { key, fallback } LocalizedText`,
          n.id
        )
      );
  }
  if (entry.binding === "required" && n.binding === undefined)
    findings.push(
      finding(
        "missing-binding",
        `"${n.type}" renders bound data and "${n.id}" has no binding`,
        n.id
      )
    );
  if (entry.binding === "none" && n.binding !== undefined)
    findings.push(
      finding(
        "unexpected-binding",
        `"${n.type}" takes no data and "${n.id}" carries a binding`,
        n.id
      )
    );
  const r = resolveSurface(catalog, n.type, n.typeVersion, surface, n.id);
  if (!r.ok && r.finding.code !== "unknown-type") findings.push(r.finding);
}
