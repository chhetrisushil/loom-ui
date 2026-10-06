import { describe, expect, it } from "vitest";
import {
  REFERENCE_CONTAINER_ROLES,
  STEPPER_ROLE,
  TABS_ROLE,
  containerRoleFindings,
  roleChildProblems,
} from "./containerRoles";
import { apply, genesis } from "./index";
import { type ContainerNode, ExperienceNode } from "./node";

const tabs = REFERENCE_CONTAINER_ROLES.find((r) => r.role === TABS_ROLE) as NonNullable<
  (typeof REFERENCE_CONTAINER_ROLES)[number]
>;
const panel = (id: string, titled = true): ContainerNode => ({
  id,
  order: id,
  kind: "container",
  direction: "column",
  span: 12,
  ...(titled && { title: { key: `${id}.t`, fallback: id } }),
  children: [],
});
const set = (role: string, kids: ContainerNode[], owner?: "planner"): ContainerNode => ({
  id: "set",
  order: "a",
  kind: "container",
  direction: "column",
  span: 12,
  role,
  ...(owner !== undefined && { owner }),
  children: kids,
});
const rootOf = (c: ContainerNode): ContainerNode => ({
  id: "root",
  order: "V",
  kind: "container",
  direction: "grid",
  span: 12,
  children: [c],
});
const child = (c: ContainerNode) => ({
  id: c.id,
  isContainer: true,
  titled: c.title !== undefined,
});

describe("container role specs (U15)", () => {
  it("ships tabs and stepper, both needing titled panels", () => {
    expect(REFERENCE_CONTAINER_ROLES.map((r) => r.role)).toEqual([TABS_ROLE, STEPPER_ROLE]);
    for (const r of REFERENCE_CONTAINER_ROLES) expect(r.children).toBe("panels");
  });

  it("roleChildProblems: count bounds, widgets, untitled panels — each named", () => {
    expect(roleChildProblems(tabs, [child(panel("a")), child(panel("b"))])).toEqual([]);
    expect(roleChildProblems(tabs, [child(panel("a"))])[0]).toMatch(/at least 2/);
    expect(
      roleChildProblems(
        tabs,
        Array.from({ length: 9 }, (_, i) => child(panel(`p${i}`)))
      )[0]
    ).toMatch(/at most 8/);
    expect(
      roleChildProblems(tabs, [child(panel("a")), { id: "w", isContainer: false, titled: false }])
    ).toEqual([expect.stringContaining('"w" is a widget')]);
    expect(roleChildProblems(tabs, [child(panel("a")), child(panel("b", false))])).toEqual([
      expect.stringContaining('"b" has no title'),
    ]);
  });

  it("a PARTIAL set skips the minimum (its children are still coming) but not the maximum", () => {
    expect(roleChildProblems(tabs, [child(panel("a"))], { partial: true })).toEqual([]);
    expect(
      roleChildProblems(
        tabs,
        Array.from({ length: 9 }, (_, i) => child(panel(`p${i}`))),
        {
          partial: true,
        }
      )
    ).toHaveLength(1);
  });

  it("containerRoleFindings judges built trees; ownedBy spares the application's own containers", () => {
    const bad = rootOf(set(TABS_ROLE, [panel("a", false), panel("b")], "planner"));
    const fs = containerRoleFindings(bad, REFERENCE_CONTAINER_ROLES);
    expect(fs).toEqual([
      expect.objectContaining({
        code: "container-role-children",
        severity: "error",
        nodeId: "set",
      }),
    ]);
    const appOwned = rootOf(set(TABS_ROLE, [panel("a", false), panel("b")]));
    expect(containerRoleFindings(appOwned, REFERENCE_CONTAINER_ROLES)).toHaveLength(1);
    expect(
      containerRoleFindings(appOwned, REFERENCE_CONTAINER_ROLES, { ownedBy: "planner" })
    ).toEqual([]);
    // a role nobody listed is not judged: which roles exist is the renderer's fact
    expect(containerRoleFindings(rootOf(set("wizard", [])), REFERENCE_CONTAINER_ROLES)).toEqual([]);
  });

  it("walks a deep tree without recursion", () => {
    let deep: ContainerNode = panel("leaf");
    for (let i = 0; i < 5000; i++) deep = { ...panel(`d${i}`), children: [deep] };
    expect(() => containerRoleFindings(rootOf(deep), REFERENCE_CONTAINER_ROLES)).not.toThrow();
  });
});

describe("ContainerNode.owner (U15)", () => {
  const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "test" };
  const intent = { objective: "x", source: "user" as const };
  const g = () => genesis({ experienceId: "e", intent, meta });
  const insert = (node: ContainerNode) => {
    const r = apply(g(), { type: "insertNode", parentId: g().root.id, node });
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };

  it('parses, and a value other than "planner" is refused', () => {
    expect(ExperienceNode.safeParse(panel("a")).success).toBe(true);
    expect(ExperienceNode.safeParse({ ...panel("a"), owner: "planner" }).success).toBe(true);
    expect(ExperienceNode.safeParse({ ...panel("a"), owner: "app" }).success).toBe(false);
  });

  it("is carried by apply, survives setRole/setTitle, and an absent owner hashes as before", () => {
    const owned = insert({ ...panel("a"), owner: "planner" });
    const plain = insert(panel("a"));
    expect(JSON.stringify(plain.root)).not.toContain("owner");
    const r1 = apply(owned, { type: "setRole", nodeId: "a", role: "tabs" });
    if (!r1.ok) throw new Error("setRole");
    const r2 = apply(r1.value, { type: "setTitle", nodeId: "a", title: null });
    if (!r2.ok) throw new Error("setTitle");
    expect(JSON.stringify(r2.value.root)).toContain('"owner":"planner"');
  });
});
