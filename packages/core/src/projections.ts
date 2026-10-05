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
  /** The viewer may not see it: compiles to the restricted placeholder, declaring nothing. */
  | { readonly kind: "restricted" }
  /** Unusable (unknown, reserved, version drift, invalid, conflicting): omitted, never faked. */
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
  const byId = new Map<string, ProjectionDescriptor>();
  for (const d of catalog ?? []) if (!byId.has(d.id)) byId.set(d.id, d);
  const verdicts = new Map<string, ProjectionVerdict>();
  const findings: Finding[] = [];
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
    const d = byId.get(b.id);
    if (d === undefined) {
      findings.push(
        err(
          "projection-unknown",
          `node "${node.id}" binds projection "${b.id}", which the host does not offer`,
          node.id
        )
      );
      verdicts.set(node.id, { kind: "refused" });
      return;
    }
    if (d.version !== b.version) {
      findings.push(
        err(
          "projection-version-mismatch",
          `node "${node.id}" pins projection "${b.id}" at "${b.version}", but the host offers "${d.version}"`,
          node.id
        )
      );
      verdicts.set(node.id, { kind: "refused" });
      return;
    }
    const sensitivity = strictestClass(b.sensitivity, d.sensitivity);
    if (sensitivity !== undefined) classified = true;
    if (!mayView(viewer, sensitivity)) {
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
