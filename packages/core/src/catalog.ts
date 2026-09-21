import type { Experience, Finding, VocabularyFloor } from "./experience";
import { type SemanticNode, walk } from "./node";

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
  readonly surfaces: Partial<Record<Surface, SurfaceResolution>>;
}
export interface SemanticCatalog {
  readonly id: string;
  readonly entries: readonly SemanticEntry[];
}

export function defineSemanticCatalog(catalog: SemanticCatalog): SemanticCatalog {
  return catalog;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
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
  const ids = new Set<string>();
  let nodes = 0;
  walk(exp.root, (n) => {
    if (ids.has(n.id))
      findings.push(finding("duplicate-node-id", `node id "${n.id}" appears more than once`, n.id));
    ids.add(n.id);
    if (n.kind !== "semantic") return;
    nodes++;
    checkSemantic(n, catalog, surface, findings);
  });
  findings.push(...checkFloor(exp, exp.vocabularyFloor));
  return { ok: findings.every((f) => f.severity !== "error"), findings, nodes };
}

function checkSemantic(
  n: SemanticNode,
  catalog: SemanticCatalog,
  surface: Surface,
  findings: Finding[]
): void {
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
