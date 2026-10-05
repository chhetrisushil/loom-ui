import type { DataClass } from "@loom/classify";
import type { Finding } from "./experience";
import type { Experience } from "./experience";
import { ProjectionBinding, type SemanticNode, walk } from "./node";
import { type Viewer, mayView, strictestClass } from "./viewer";

// ── Projections a host offers ─────────────────────────────────────────────────
// A node may bind any loom projection, not only the hydration one (`SemanticNode.projection`).
// Which projections EXIST is the host's fact, not the Experience's, so `compile` is given a
// catalogue of them (`CompileOptions.projections`): one descriptor per projection, naming its id,
// its current declared version (loom ADR 0095's `projectionVersions` source — what
// `projectionRuntime.pins()` reports) and the confidentiality class of what it publishes. The
// catalogue is the authority: an id it does not list is `projection-unknown`, a version pin that
// differs is `projection-version-mismatch`, and its class can only RAISE a node's own declared
// class. FAIL-CLOSED: no catalogue offers nothing, so every projection binding is refused.

export interface ProjectionDescriptor {
  readonly id: string;
  /** The projection's declared version today (ADR 0095). A node's `version` pin must equal it. */
  readonly version: string;
  /** The strictest class of anything this projection publishes; absent = unclassified. */
  readonly sensitivity?: DataClass;
  /** Display text for a planner or an inspector; never read by `compile`. */
  readonly description?: string;
}

export type ProjectionCatalog = readonly ProjectionDescriptor[];

/** What `compile` does with one projection-bound node. */
export type ProjectionVerdict =
  | { readonly kind: "ok"; readonly binding: ProjectionBinding; readonly sensitivity?: DataClass }
  /**
   * The viewer may not see it — or the projection is unknown or drifted, which must look the same
   * to the viewer: compiles to the restricted placeholder, declaring nothing.
   */
  | { readonly kind: "restricted" }
  /** Unusable (reserved, invalid, conflicting): omitted, never faked. */
  | { readonly kind: "refused" };

export interface ProjectionPlan {
  readonly verdicts: ReadonlyMap<string, ProjectionVerdict>;
  readonly findings: readonly Finding[];
  /** id → version for every projection a VISIBLE node binds (a restricted node declares nothing). */
  readonly used: ReadonlyMap<string, string>;
  /** True iff some projection-bound node carries a class (so a missing viewer is worth a warn). */
  readonly classified: boolean;
}

const err = (code: string, message: string, nodeId: string): Finding => ({
  code,
  severity: "error",
  message,
  nodeId,
});

/**
 * Judge every projection-bound node against the host's catalogue and the viewer. Pure and total:
 * a malformed node, an unknown projection or a hostile id is a finding, never a throw. Messages
 * echo only the node id and the id the AUTHOR wrote on that node (never another projection's
 * descriptor), so a refusal cannot be used to enumerate what the host offers.
 */
export function planProjectionBindings(
  exp: Experience,
  catalog: ProjectionCatalog | undefined,
  hydrationProjectionId: string,
  viewer: Viewer | undefined
): ProjectionPlan {
  const findings: Finding[] = [];
  // The catalogue, merged: a duplicate id is the SAME projection described twice, so the strictest
  // class wins (first-wins would let a later, classified entry be ignored); two different versions
  // are ambiguous and refuse the id.
  const byId = new Map<string, ProjectionDescriptor>();
  const conflicted = new Set<string>();
  for (const d of catalog ?? []) {
    const had = byId.get(d.id);
    if (had === undefined) {
      byId.set(d.id, d);
      continue;
    }
    if (had.version !== d.version) {
      if (!conflicted.has(d.id))
        findings.push({
          code: "projection-catalog-conflict",
          severity: "error",
          message: `the projection catalogue lists "${d.id}" at more than one version: it is refused`,
        });
      conflicted.add(d.id);
      continue;
    }
    const sensitivity = strictestClass(had.sensitivity, d.sensitivity);
    byId.set(d.id, { ...had, ...(sensitivity !== undefined && { sensitivity }) });
  }
  // The class of a projection is ONE value for every node that binds it (one projection gives each
  // of them the same state, and the Blueprint declares it whole): the strictest of every node's
  // own class, the Experience's sticky `projectionClasses` and the catalogue's.
  const classOf = new Map<string, DataClass>();
  const raise = (id: string, c: DataClass | undefined): void => {
    const m = strictestClass(classOf.get(id), c);
    if (m !== undefined) classOf.set(id, m);
  };
  for (const [id, c] of Object.entries(exp.projectionClasses ?? {})) raise(id, c);
  for (const d of byId.values()) raise(d.id, d.sensitivity);
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.projection === undefined) return;
    const parsed = ProjectionBinding.safeParse(n.projection);
    if (parsed.success) raise(parsed.data.id, parsed.data.sensitivity);
  });
  const verdicts = new Map<string, ProjectionVerdict>();
  const used = new Map<string, string>();
  let classified = false;
  walk(exp.root, (n) => {
    if (n.kind !== "semantic") return;
    const node: SemanticNode = n;
    if (node.projection === undefined) return;
    const parsed = ProjectionBinding.safeParse(node.projection);
    if (!parsed.success) {
      findings.push(
        err(
          "projection-binding-invalid",
          `node "${node.id}" has a malformed projection binding`,
          node.id
        )
      );
      verdicts.set(node.id, { kind: "refused" });
      return;
    }
    const b = parsed.data;
    if (node.binding !== undefined) {
      // `binding-conflict` is reported by `validateExperience`; here the node is just not emitted.
      verdicts.set(node.id, { kind: "refused" });
      return;
    }
    if (b.id === hydrationProjectionId) {
      findings.push(
        err(
          "projection-reserved",
          `node "${node.id}" binds the hydration projection through \`projection\`: bind a provider handle instead`,
          node.id
        )
      );
      verdicts.set(node.id, { kind: "refused" });
      return;
    }
    const sensitivity = classOf.get(b.id);
    if (sensitivity !== undefined) classified = true;
    const d = byId.get(b.id);
    const canSee = mayView(viewer, sensitivity);
    // Unknown, version-drifted and restricted all compile to the SAME placeholder, so what the
    // viewer sees cannot be used to ask the host which projections exist or at which version. The
    // host still gets the error finding. The viewer/class check runs BEFORE the version one, and
    // the offered version appears in a message only for a viewer who may see the class.
    if (d === undefined || conflicted.has(b.id)) {
      if (!conflicted.has(b.id))
        findings.push(
          err(
            "projection-unknown",
            `node "${node.id}" binds projection "${b.id}", which the host does not offer`,
            node.id
          )
        );
      verdicts.set(node.id, { kind: "restricted" });
      return;
    }
    if (d.version !== b.version) {
      findings.push(
        err(
          "projection-version-mismatch",
          canSee
            ? `node "${node.id}" pins projection "${b.id}" at "${b.version}", but the host offers "${d.version}"`
            : `node "${node.id}" pins projection "${b.id}" at a version the host does not offer`,
          node.id
        )
      );
      verdicts.set(node.id, { kind: "restricted" });
      return;
    }
    if (!canSee) {
      verdicts.set(node.id, { kind: "restricted" });
      return;
    }
    used.set(b.id, d.version);
    verdicts.set(node.id, {
      kind: "ok",
      binding: b,
      ...(sensitivity !== undefined && { sensitivity }),
    });
  });
  return { verdicts, findings, used, classified };
}
