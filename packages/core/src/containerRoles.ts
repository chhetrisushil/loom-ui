import type { Finding } from "./experience";
import type { ContainerNode, ExperienceNode } from "./node";

// ── A reference vocabulary of container roles (U15) ───────────────────────────
// The Blueprint IR already carries an open `role` on every container (loom ADR 0099): a registry
// key a renderer MAY give chrome for. loom ships no vocabulary and neither does the IR; these are
// the two roles loom-ui's own DOM renderers implement (`renderer-lit`'s `referenceContainers`) and
// the reference planner can be offered (`ComposeInput.containers`). An app with its own role names
// declares its own specs; nothing here is enforced on an experience that does not ask for it.
//
// A role spec says what its CHILDREN must look like, because a tab strip or a step list labels each
// child from the child's own `title` and cannot draw one that has none. The same predicate runs on
// a planner draft (`roleChildProblems` over its entries) and on a built tree (`containerRoleFindings`).

/** What a role's children must be: `any` node, or `panels` — containers that each carry a title. */
export type RoleChildren = "any" | "panels";

export interface ContainerRoleSpec {
  /** The `Layout.role` / `ContainerNode.role` key (`isLayoutRole`). */
  readonly role: string;
  /** One line a model reads: what the container is and what its children are. */
  readonly description: string;
  /** What the children must be. Default `any`. */
  readonly children?: RoleChildren;
  /** At least this many children. Default 1. */
  readonly minChildren?: number;
  /** At most this many children. Default unbounded (the planner's own caps still apply). */
  readonly maxChildren?: number;
}

export const TABS_ROLE = "tabs";
export const STEPPER_ROLE = "stepper";

/** The roles `renderer-lit` ships container renderers for. */
export const REFERENCE_CONTAINER_ROLES: readonly ContainerRoleSpec[] = [
  {
    role: TABS_ROLE,
    description:
      "a tab set: each child is a titled container (one panel); the title is the tab label; one panel shows at a time",
    children: "panels",
    minChildren: 2,
    maxChildren: 8,
  },
  {
    role: STEPPER_ROLE,
    description:
      "a step-by-step flow: each child is a titled container (one step); the title is the step name; one step shows at a time, in order",
    children: "panels",
    minChildren: 2,
    maxChildren: 12,
  },
];

/** What a child looks like to a role rule — the part of a node (or a draft entry) the rule reads. */
export interface RoleChild {
  readonly id: string;
  readonly isContainer: boolean;
  readonly titled: boolean;
}

/** Why `children` cannot be the children of a `spec` container; empty when they can. */
export function roleChildProblems(
  spec: ContainerRoleSpec,
  children: readonly RoleChild[],
  opts: { readonly partial?: boolean } = {}
): string[] {
  const out: string[] = [];
  const min = spec.minChildren ?? 1;
  if (!opts.partial && children.length < min)
    out.push(`a "${spec.role}" container needs at least ${min} child(ren), has ${children.length}`);
  if (spec.maxChildren !== undefined && children.length > spec.maxChildren)
    out.push(
      `a "${spec.role}" container holds at most ${spec.maxChildren} children, has ${children.length}`
    );
  if (spec.children === "panels")
    for (const c of children) {
      if (!c.isContainer)
        out.push(
          `"${c.id}" is a widget; every child of a "${spec.role}" container must be a titled container`
        );
      else if (!c.titled)
        out.push(
          `"${c.id}" has no title; every child of a "${spec.role}" container needs one (it is the label)`
        );
    }
  return out;
}

const asChild = (n: ExperienceNode): RoleChild => ({
  id: n.id,
  isContainer: n.kind === "container",
  titled: n.kind === "container" && n.title !== undefined && n.title.fallback !== "",
});

/**
 * Findings for every container in `root` whose role is in `specs` and whose children break that
 * role's rule. ERRORS: such a container is drawn as a plain one by a renderer that cannot label
 * its children, which is not what its author composed. Containers with an unlisted role are
 * not judged (which roles exist is the renderer's fact); `ownedBy` judges only the containers an
 * author owns (a planner must not refuse a shape the application itself composed). Iterative
 * and linear in the tree.
 */
export function containerRoleFindings(
  root: ExperienceNode,
  specs: readonly ContainerRoleSpec[],
  opts: { readonly ownedBy?: NonNullable<ContainerNode["owner"]> } = {}
): Finding[] {
  const byRole = new Map(specs.map((s) => [s.role, s] as const));
  const out: Finding[] = [];
  const stack: ExperienceNode[] = [root];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n.kind !== "container") continue;
    const c: ContainerNode = n;
    const spec = c.role === undefined ? undefined : byRole.get(c.role);
    if (spec !== undefined && (opts.ownedBy === undefined || c.owner === opts.ownedBy))
      for (const message of roleChildProblems(spec, c.children.map(asChild)))
        out.push({ code: "container-role-children", severity: "error", message, nodeId: c.id });
    for (const k of c.children) stack.push(k);
  }
  return out;
}
