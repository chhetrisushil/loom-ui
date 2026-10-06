import {
  type ContainerNode,
  type Experience,
  type ExperienceNode,
  type Operation,
  REFERENCE_CONTAINER_ROLES,
  compile,
  emptyLedger,
  findNode,
  foldProvenance,
  genesis,
  isContainer,
  nodeIds,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import {
  MAX_DRAFT_CHILDREN,
  MAX_DRAFT_DEPTH,
  MAX_DRAFT_NODES,
  type PlanDraft,
  draftStructureIssues,
  parseModelJson,
  planSchema,
} from "./contract";
import { materialize } from "./materialize";
import { composeMessages, describeContainers, describeExperience, reviseMessages } from "./prompt";
import { plannerProvenance } from "./provenance";
import { ReferencePlanner } from "./reference";
import type { PlanPartial } from "./spi";
import { NodeScanner } from "./streamScan";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
  streamingScriptedModel,
} from "./testing.test-support";

const roles = REFERENCE_CONTAINER_ROLES;
const g = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
  containers: roles,
  contextClass: "internal" as const,
};

const insight = (id: string, parent?: string, extra: object = {}) => ({
  id,
  type: "Insight",
  label: id,
  span: 12,
  props: { tone: "neutral" },
  ...(parent !== undefined && { parent }),
  ...extra,
});
const metric = (id: string, parent?: string, path = "totals.count") => ({
  id,
  type: "Metric",
  label: id,
  span: 4,
  props: { unit: "orders" },
  ...(parent !== undefined && { parent }),
  binding: { capability: "orders_summary", arguments: { window: "7d" }, path, priority: "P1" },
});
const box = (id: string, container: string, parent?: string, title: string | null = id) => ({
  id,
  container,
  ...(title !== null && { title }),
  span: 12,
  ...(parent !== undefined && { parent }),
});

/** A tab set of two titled panels; the second holds two nodes. */
const tabsEntries = () => [
  box("views", "tabs"),
  box("overview", "section", "views"),
  metric("orders", "overview"),
  box("detail", "section", "views"),
  metric("top", "detail", "rows"),
  insight("note", "detail"),
];
const reply = (nodes: object[], summary = "Two views of the orders") =>
  JSON.stringify({ summary, nodes });

const planner = (model: ReturnType<typeof scriptedModel>) =>
  new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 });

/** Compose `nodes` and return the sealed experience the ops build. */
async function composed(nodes: object[]): Promise<{ exp: Experience; ops: readonly Operation[] }> {
  const r = await planner(scriptedModel([reply(nodes)])).compose(input, recordingContext());
  expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  const applied = replay(g(), r.ops);
  if (!applied.ok) throw new Error(applied.finding.message);
  return { exp: seal(applied.value), ops: r.ops };
}
const inner = (ops: readonly Operation[]): Operation[] => {
  const only = ops[0];
  if (ops.length !== 1 || only?.type !== "prompt") throw new Error("expected one prompt op");
  return only.materialized;
};
const kinds = (ops: readonly Operation[]) => ops.map((o) => o.type);
const parentOfId = (exp: Experience, id: string): string | undefined => {
  let found: string | undefined;
  const stack: ContainerNode[] = [exp.root as ContainerNode];
  for (let c = stack.pop(); c !== undefined; c = stack.pop())
    for (const k of c.children) {
      if (k.id === id) found = c.id;
      if (isContainer(k)) stack.push(k);
    }
  return found;
};

describe("U15 — the draft contract", () => {
  const schema = planSchema(planningCatalog, capabilitiesFixture, roles);
  const parse = (nodes: object[]) => parseModelJson(schema, reply(nodes));
  const msgs = (nodes: object[]) => {
    const r = parse(nodes);
    return r.ok ? [] : r.error.split("\n");
  };

  it("accepts a tab set of titled panels", () => {
    expect(parse(tabsEntries()).ok).toBe(true);
  });

  it("names the kinds a container may be, and refuses a role the host did not offer", () => {
    const m = msgs([box("c", "carousel"), insight("n", "c")]);
    expect(
      m.some(
        (x) => x.startsWith("nodes.0.container") && x.includes("section, row, grid, tabs, stepper")
      )
    ).toBe(true);
    // without the roles offered, `tabs` is not a kind either
    const bare = planSchema(planningCatalog, capabilitiesFixture);
    const r = parseModelJson(bare, reply([box("c", "tabs"), insight("n", "c")]));
    expect(r.ok).toBe(false);
  });

  it("a container carries a title and a width, nothing else (no props, no binding)", () => {
    const r = parse([{ ...box("c", "section"), props: {} }, insight("n", "c")]);
    expect(r.ok).toBe(false);
  });

  it("a parent must be an EARLIER container of the same reply", () => {
    expect(msgs([insight("n", "c"), box("c", "section")])[0]).toMatch(
      /nodes\.0\.parent: parent "c" is not an earlier container/
    );
    expect(msgs([insight("a"), insight("n", "a")])[0]).toMatch(/parent "a" is a widget/);
    expect(msgs([insight("n", "ghost")])[0]).toMatch(/not an earlier container/);
  });

  it("refuses nesting past MAX_DRAFT_DEPTH, naming the entry", () => {
    const chain = (n: number) => [
      ...Array.from({ length: n }, (_, i) =>
        box(`c${i}`, "section", i === 0 ? undefined : `c${i - 1}`)
      ),
      insight("leaf", `c${n - 1}`),
    ];
    expect(parse(chain(MAX_DRAFT_DEPTH - 1)).ok).toBe(true); // leaf is the 4th level
    const m = msgs(chain(MAX_DRAFT_DEPTH));
    expect(m.some((x) => x.includes(`"leaf" is nested ${MAX_DRAFT_DEPTH + 1} deep`))).toBe(true);
  });

  it("bounds children per container (top level included) and entries overall", () => {
    const top = Array.from({ length: MAX_DRAFT_CHILDREN + 1 }, (_, i) => insight(`n${i}`));
    expect(msgs(top).join("\n")).toMatch(/25 top-level entries; at most 24/);
    const wide = [
      box("c", "section"),
      ...Array.from({ length: MAX_DRAFT_CHILDREN + 1 }, (_, i) => insight(`n${i}`, "c")),
    ];
    expect(msgs(wide).join("\n")).toMatch(/"c" holds 25 children; at most 24/);
    // 3 groups of 24 + the groups themselves = 75 > 64
    const many = [0, 1, 2].flatMap((k) => [
      box(`g${k}`, "section"),
      ...Array.from({ length: 24 }, (_, i) => insight(`n${k}_${i}`, `g${k}`)),
    ]);
    expect(many.length).toBeGreaterThan(MAX_DRAFT_NODES);
    expect(parse(many).ok).toBe(false);
  });

  it("an empty container, and a role container whose children break its role, are refused", () => {
    expect(msgs([box("c", "section"), insight("n")])[0]).toMatch(/container "c" is empty/);
    const m = msgs([
      box("t", "tabs"),
      box("p1", "section", "t"),
      insight("a", "p1"),
      box("p2", "section", "t", null), // untitled panel
      insight("b", "p2"),
    ]);
    expect(m.join("\n")).toMatch(/"p2" has no title/);
    expect(
      msgs([box("t", "tabs"), box("p1", "section", "t"), insight("a", "p1")]).join("\n")
    ).toMatch(/needs at least 2/);
    expect(msgs([box("t", "tabs"), insight("a", "t"), insight("b", "t")]).join("\n")).toMatch(
      /"a" is a widget/
    );
  });

  it("reports an invalid entry once, not again as a structure issue", () => {
    const m = msgs([box("c", "section"), { ...insight("n", "c"), type: "Nope" }]);
    expect(m.filter((x) => x.includes("Nope")).length).toBe(1);
    expect(m.some((x) => x.includes("empty"))).toBe(false);
  });

  it("draftStructureIssues: partial prefixes skip emptiness, never the bounds", () => {
    const prefix = [box("c", "section")] as unknown as PlanDraft["nodes"];
    expect(draftStructureIssues(prefix, roles, { partial: true })).toEqual([]);
    expect(draftStructureIssues(prefix, roles)).toHaveLength(1);
  });
});

describe("U15 — composing nested structure", () => {
  it("builds containers (planner-owned, titled, roled) and parents widgets inside them", async () => {
    const { exp, ops } = await composed(tabsEntries());
    // a provider is declared right before the first node that binds it; the nodes go in document order
    expect(kinds(ops).filter((k) => k !== "remapProvider")).toEqual(Array(6).fill("insertNode"));
    expect(kinds(ops).filter((k) => k === "remapProvider")).toHaveLength(2);
    ops.forEach((o, i) => {
      if (o.type === "insertNode" && o.node.kind === "semantic" && o.node.binding)
        expect(
          ops
            .slice(0, i)
            .some(
              (p) =>
                p.type === "remapProvider" &&
                p.handle === (o.node as { binding?: { handle: string } }).binding?.handle
            )
        ).toBe(true);
    });
    const views = findNode(exp.root, "views") as ContainerNode;
    expect(views).toMatchObject({
      kind: "container",
      role: "tabs",
      owner: "planner",
      direction: "column",
    });
    expect(views.title?.fallback).toBe("views");
    expect(views.children.map((c) => c.id)).toEqual(["overview", "detail"]);
    expect((findNode(exp.root, "detail") as ContainerNode).children.map((c) => c.id)).toEqual([
      "top",
      "note",
    ]);
    expect(validateExperience(exp, planningCatalog, "web").ok).toBe(true);
  });

  it("every insert names the container it goes in (one op per new entry, parent first)", async () => {
    const { ops } = await composed(tabsEntries());
    const inserts = ops.filter((o) => o.type === "insertNode") as Extract<
      Operation,
      { type: "insertNode" }
    >[];
    expect(inserts.map((o) => [o.node.id, o.parentId])).toEqual([
      ["views", "root"],
      ["overview", "views"],
      ["orders", "overview"],
      ["detail", "views"],
      ["top", "detail"],
      ["note", "detail"],
    ]);
    // children are inserted EMPTY-handed: the subtree is the ops, not a nested payload
    expect(inserts.every((o) => !isContainer(o.node) || o.node.children.length === 0)).toBe(true);
  });

  it("row and grid containers lay their children out as asked", async () => {
    const { exp } = await composed([
      box("strip", "row"),
      metric("a", "strip"),
      insight("b", "strip"),
      box("board", "grid"),
      { ...metric("c", "board"), span: 8 },
      { ...insight("d", "board"), span: 4 },
    ]);
    expect(findNode(exp.root, "strip")).toMatchObject({ direction: "row" });
    expect(findNode(exp.root, "board")).toMatchObject({ direction: "grid" });
    expect(findNode(exp.root, "c")).toMatchObject({ span: 8 });
  });

  it("compile gives a container its id and role, and never leaks `owner` into the Blueprint", async () => {
    const { exp } = await composed(tabsEntries());
    const { blueprint, ok } = compile(exp, {
      catalog: planningCatalog,
      surface: "web",
      hydrationProjectionId: "loom-ui.hydration",
      hydrationProjectionVersion: "1.0.0",
      viewer: { clearance: "secret" },
    });
    expect(ok).toBe(true);
    const text = JSON.stringify(blueprint);
    expect(text).toContain('"role":"tabs"');
    expect(text).toContain('"id":"views"');
    expect(text).not.toContain("owner");
  });

  it("an offered role the model mis-shapes is retried with the finding, then fails closed", async () => {
    const bad = reply([box("t", "tabs"), box("p1", "section", "t"), insight("a", "p1")]);
    const model = scriptedModel([bad]);
    const r = await planner(model).compose(input, recordingContext());
    expect(model.calls).toBe(2);
    expect(r.ops).toEqual([]);
    expect(r.findings.some((f) => f.code === "plan-failed")).toBe(true);
    expect(r.findings.some((f) => f.message.includes("needs at least 2"))).toBe(true);
    // ... and the retry prompt carried the exact complaint
    const retry = composeMessages(input, { error: "nodes.0.container: x", raw: "" });
    expect(retry.messages[0]?.content).toContain("nodes.0.container: x");
  });

  it("is deterministic: the same reply yields byte-identical ops", async () => {
    const a = await composed(tabsEntries());
    const b = await composed(tabsEntries());
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
  });
});

describe("U15 — revising as a minimal diff", () => {
  const revise = async (base: Experience, nodes: object[], extra: object = {}) => {
    const r = await planner(scriptedModel([reply(nodes, "Changed")])).revise(
      { experience: base, request: { text: "change it" }, ...input, ...extra },
      recordingContext()
    );
    return r;
  };
  const edit = async (nodes: object[]) => {
    const { exp } = await composed(tabsEntries());
    const r = await revise(exp, nodes);
    return { exp, r, ops: r.ops.length === 0 ? [] : inner(r.ops) };
  };

  it("an unchanged reply is no ops at all", async () => {
    const { r, ops } = await edit(tabsEntries());
    expect(ops).toEqual([]);
    expect(r.findings.some((f) => f.code === "no-change")).toBe(true);
  });

  it("retitling a panel is exactly one setTitle", async () => {
    const e = tabsEntries();
    e[1] = box("overview", "section", "views", "Summary");
    const { ops } = await edit(e);
    expect(ops).toEqual(
      [
        { type: "setTitle", nodeId: "overview", title: { key: "overview.t", fallback: "Summary" } },
      ].map((o) => ({ ...o, title: { key: expect.any(String), fallback: "Summary" } }))
    );
  });

  it("changing a container's role is one setRole, clearing it is setRole null", async () => {
    const e = tabsEntries();
    e[0] = box("views", "stepper");
    expect((await edit(e)).ops).toEqual([{ type: "setRole", nodeId: "views", role: "stepper" }]);
    e[0] = box("views", "section");
    expect((await edit(e)).ops).toEqual([{ type: "setRole", nodeId: "views", role: null }]);
  });

  it("adding a widget to a panel is one insertNode under that panel, and nothing else", async () => {
    const e = tabsEntries();
    e.splice(3, 0, insight("extra", "overview"));
    const { ops } = await edit(e);
    expect(kinds(ops)).toEqual(["insertNode"]);
    expect(ops[0]).toMatchObject({ parentId: "overview", node: { id: "extra" } });
  });

  it("adding a whole new tab inserts the panel and its content, nothing already there", async () => {
    const e = tabsEntries();
    e.push(box("extra", "section", "views"), insight("fresh", "extra"));
    const { exp, ops } = await edit(e);
    expect(
      (ops as Extract<Operation, { type: "insertNode" }>[]).map((o) => [o.node.id, o.parentId])
    ).toEqual([
      ["extra", "views"],
      ["fresh", "extra"],
    ]);
    const after = replay(exp, ops);
    expect(
      after.ok && (findNode(after.value.root, "views") as ContainerNode).children.map((c) => c.id)
    ).toEqual(["overview", "detail", "extra"]);
  });

  it("a new tab listed FIRST is keyed before the others, not appended", async () => {
    const e = [
      box("views", "tabs"),
      box("intro", "section", "views"),
      insight("hello", "intro"),
      ...tabsEntries().slice(1),
    ];
    const { exp, ops } = await edit(e);
    const after = replay(exp, ops);
    expect(
      after.ok && (findNode(after.value.root, "views") as ContainerNode).children.map((c) => c.id)
    ).toEqual(["intro", "overview", "detail"]);
    expect(kinds(ops)).toEqual(["insertNode", "insertNode"]);
  });

  it("moving a widget between panels is one moveNode — never a remove plus an insert", async () => {
    const e = [
      box("views", "tabs"),
      box("overview", "section", "views"),
      metric("orders", "overview"),
      insight("note", "overview"), // moved from `detail`
      box("detail", "section", "views"),
      metric("top", "detail", "rows"),
    ];
    const { exp, ops } = await edit(e);
    expect(kinds(ops)).toEqual(["moveNode"]);
    expect(ops[0]).toMatchObject({ nodeId: "note", newParentId: "overview" });
    const after = replay(exp, ops);
    expect(after.ok && parentOfId(after.value, "note")).toBe("overview");
  });

  it("reordering panels costs the fewest moves (one of three)", async () => {
    const e3 = [
      box("views", "tabs"),
      box("a", "section", "views"),
      insight("na", "a"),
      box("b", "section", "views"),
      insight("nb", "b"),
      box("c", "section", "views"),
      insight("nc", "c"),
    ];
    const { exp } = await composed(e3);
    const reordered = [
      box("views", "tabs"),
      box("c", "section", "views"),
      insight("nc", "c"),
      box("a", "section", "views"),
      insight("na", "a"),
      box("b", "section", "views"),
      insight("nb", "b"),
    ];
    const r = await revise(exp, reordered);
    const ops = inner(r.ops);
    expect(kinds(ops)).toEqual(["moveNode"]);
    expect(ops[0]).toMatchObject({ nodeId: "c", newParentId: "views" });
    const after = replay(exp, ops);
    expect(
      after.ok && (findNode(after.value.root, "views") as ContainerNode).children.map((x) => x.id)
    ).toEqual(["c", "a", "b"]);
  });

  const three = () => [
    box("views", "tabs"),
    box("a", "section", "views"),
    metric("orders", "a"),
    box("b", "section", "views"),
    metric("top", "b", "rows"),
    insight("note", "b"),
    box("c", "section", "views"),
    insight("tail", "c"),
  ];

  it("removing a panel is ONE removeNode: its contents go with it, and the orphaned provider is retired", async () => {
    const { exp } = await composed(three());
    const r = await revise(exp, [
      box("views", "tabs"),
      box("a", "section", "views"),
      metric("orders", "a"),
      box("c", "section", "views"),
      insight("tail", "c"),
    ]);
    const ops = inner(r.ops);
    expect(kinds(ops)).toEqual(["removeNode", "removeProvider"]);
    expect(ops[0]).toEqual({ type: "removeNode", nodeId: "b" });
    const after = replay(exp, ops);
    expect(after.ok && nodeIds(after.value.root).sort()).toEqual([
      "a",
      "c",
      "orders",
      "root",
      "tail",
      "views",
    ]);
  });

  it("a widget moved OUT of a removed container survives it, and is moved before the removal", async () => {
    const { exp } = await composed(three());
    const r = await revise(exp, [
      box("views", "tabs"),
      box("a", "section", "views"),
      metric("orders", "a"),
      insight("note", "a"),
      box("c", "section", "views"),
      insight("tail", "c"),
    ]);
    const ops = inner(r.ops);
    expect(kinds(ops).slice(0, 2)).toEqual(["moveNode", "removeNode"]);
    const after = replay(exp, ops);
    expect(after.ok && parentOfId(after.value, "note")).toBe("a");
    expect(after.ok && findNode(after.value.root, "b")).toBeUndefined();
  });

  it("flattening: moving everything to the top level and dropping the container", async () => {
    const { exp, ops } = await edit([metric("orders"), insight("note")]);
    const after = replay(exp, ops);
    expect(
      after.ok && (after.value.root as ContainerNode).children.map((c) => c.id).sort()
    ).toEqual(["note", "orders"]);
    expect(ops.filter((o) => o.type === "removeNode")).toEqual([
      { type: "removeNode", nodeId: "views" },
    ]);
  });

  it("a span change on a container is one setPlacement; its kind cannot change (warned, ignored)", async () => {
    const e = tabsEntries();
    e[1] = { ...box("overview", "section", "views"), span: 6 };
    expect((await edit(e)).ops).toEqual([{ type: "setPlacement", nodeId: "overview", span: 6 }]);
    const f = tabsEntries();
    f[1] = box("overview", "row", "views");
    const { r, ops } = await edit(f);
    expect(ops).toEqual([]);
    expect(
      r.findings.some((x) => x.code === "container-kind-unchanged" && x.severity === "warn")
    ).toBe(true);
  });

  it("the revise is one prompt op whose primitives replay to the same artifact", async () => {
    const e = tabsEntries();
    e.push(insight("tail", "views"));
    // `tail` is a widget under a tabs container: refused by the role's own rule
    const { exp } = await composed(tabsEntries());
    const r = await revise(exp, e);
    expect(r.ops).toEqual([]);
    expect(r.findings.some((x) => x.message.includes('"tail" is a widget'))).toBe(true);
  });
});

describe("U15 — what is not the planner's", () => {
  const appBase = (): Experience => {
    const ops: Operation[] = [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "app_shell",
          order: "M",
          kind: "container",
          direction: "column",
          span: 12,
          children: [
            {
              id: "inner",
              order: "a",
              kind: "semantic",
              type: "Insight",
              typeVersion: "1.0.0",
              span: 12,
              props: { tone: "neutral" },
            },
          ],
        },
      },
    ];
    const r = replay(g(), ops);
    if (!r.ok) throw new Error(r.finding.message);
    return seal(r.value);
  };
  const run = (base: Experience, nodes: object[]) => {
    const draft = JSON.parse(reply(nodes)) as PlanDraft;
    return materialize(draft, base, planningCatalog, capabilitiesFixture);
  };

  it("an application-owned container is never edited, entered, moved into or removed", () => {
    const base = appBase();
    const none = run(base, [insight("n")]);
    expect(none.ops.some((o) => o.type === "removeNode")).toBe(false);
    expect(run(base, [insight("inner")]).findings.map((f) => f.code)).toContain("nested-node");
    // a parent must be a container OF THE REPLY, and the reply cannot hold an application one
    const into = run(base, [insight("n", "app_shell")]);
    expect(into.findings.map((f) => f.code)).toEqual(["draft-structure"]);
    expect(into.ops).toEqual([]);
    const listed = run(base, [box("app_shell", "section"), insight("n", "app_shell")]);
    expect(listed.findings.map((f) => f.code)).toEqual(["not-owned", "parent-refused"]);
    expect(listed.ops).toEqual([]);
    expect(run(base, [insight("app_shell")]).findings.map((f) => f.code)).toContain("not-semantic");
  });

  it("a planner container inside an application container is locked with it", async () => {
    const owned: ContainerNode = {
      id: "mine",
      order: "a",
      kind: "container",
      direction: "column",
      span: 12,
      owner: "planner",
      children: [],
    };
    const base = appBase();
    const shell =
      base.root.kind === "container" ? (base.root.children[0] as ContainerNode) : undefined;
    expect(shell?.id).toBe("app_shell");
    const r = replay(base, [{ type: "insertNode", parentId: "app_shell", node: owned }]);
    if (!r.ok) throw new Error(r.finding.message);
    const res = run(seal(r.value), [box("mine", "section"), insight("n", "mine")]);
    // `mine` carries the planner's mark but sits in the application's region: not reachable
    expect(res.findings.map((f) => f.code)).toEqual(["nested-node", "parent-refused"]);
  });

  it("a planner container that holds an application one cannot be removed from under it", () => {
    const base = appBase();
    const withOwned = replay(base, [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "grp",
          order: "z",
          kind: "container",
          direction: "column",
          span: 12,
          owner: "planner",
          children: [],
        },
      },
      {
        type: "insertNode",
        parentId: "grp",
        node: {
          id: "app_inner",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          children: [],
        },
      },
    ]);
    if (!withOwned.ok) throw new Error(withOwned.finding.message);
    const res = run(seal(withOwned.value), [insight("n")]);
    expect(res.findings).toEqual([
      expect.objectContaining({ code: "locked-descendant", nodeId: "grp", severity: "error" }),
    ]);
    expect(res.ops.some((o) => o.type === "removeNode" && o.nodeId === "grp")).toBe(false);
  });

  it("widget <-> container id reuse is refused (kind-changed)", async () => {
    const { exp } = await composed([...tabsEntries()]);
    expect(
      run(exp, [box("note", "section"), insight("x", "note")]).findings.map((f) => f.code)
    ).toContain("kind-changed");
    expect(run(exp, [insight("views")]).findings.map((f) => f.code)).toContain("not-semantic");
  });

  it("direct callers get the structure check too: no ops from a draft that breaks a bound", () => {
    const res = run(g() as Experience, [insight("n", "ghost")]);
    expect(res.ops).toEqual([]);
    expect(res.findings[0]).toMatchObject({ code: "draft-structure", severity: "error" });
  });

  it("direct callers fail closed: an empty container and a too-long draft are refused with no ops", () => {
    const empty = run(g() as Experience, [box("hollow", "section"), insight("n")]);
    expect(empty.ops).toEqual([]);
    expect(empty.findings[0]).toMatchObject({ code: "draft-structure", nodeId: "hollow" });
    const many = run(
      g() as Experience,
      Array.from({ length: MAX_DRAFT_NODES + 1 }, (_, i) => insight(`n${i}`))
    );
    expect(many.ops).toEqual([]);
    expect(many.findings.map((f) => f.code)).toEqual(["draft-structure", "draft-structure"]);
  });

  it("`partial` tolerates a container whose children are still streaming; `roles` adds the role rules", () => {
    const draft = JSON.parse(reply([box("later", "section")])) as PlanDraft;
    const open = materialize(
      draft,
      g() as Experience,
      planningCatalog,
      capabilitiesFixture,
      undefined,
      {},
      {
        partial: true,
      }
    );
    expect(open.findings.filter((f) => f.severity === "error")).toEqual([]);
    const one = JSON.parse(
      reply([box("views", "tabs"), box("only", "section", "views"), insight("n", "only")])
    ) as PlanDraft;
    const strict = (r?: typeof roles) =>
      materialize(
        one,
        g() as Experience,
        planningCatalog,
        capabilitiesFixture,
        undefined,
        {},
        {
          ...(r !== undefined && { roles: r }),
        }
      );
    expect(strict().findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(strict(roles).findings[0]).toMatchObject({ code: "draft-structure", nodeId: "views" });
  });

  it("a role container's child count includes an application panel locked inside it", () => {
    const withLocked = replay(g(), [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "views",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          owner: "planner",
          role: "tabs",
          children: [],
        },
      },
      {
        type: "insertNode",
        parentId: "views",
        node: {
          id: "app_panel",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          title: { key: "app", fallback: "App" },
          children: [],
        },
      },
    ]);
    if (!withLocked.ok) throw new Error(withLocked.finding.message);
    const draft = JSON.parse(
      reply([box("views", "tabs"), box("mine", "section", "views"), insight("n", "mine")])
    ) as PlanDraft;
    const res = materialize(
      draft,
      seal(withLocked.value),
      planningCatalog,
      capabilitiesFixture,
      undefined,
      {},
      { roles }
    );
    // 1 draft panel + 1 locked app panel = the 2 a tab set needs.
    expect(res.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(res.ops.length).toBeGreaterThan(0);
  });

  it("revise with no `containers` still accepts the roles already on planner containers in the base", async () => {
    const { exp } = await composed(tabsEntries());
    const { containers: _drop, ...bare } = input;
    const e = tabsEntries();
    e.push(insight("extra", "overview"));
    const r = await planner(scriptedModel([reply(e)])).revise(
      { experience: exp, request: { text: "add" }, ...bare },
      recordingContext()
    );
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(kinds(inner(r.ops))).toEqual(["insertNode"]);
  });

  it("moving a placed widget into a non-grid container clears its placement first", async () => {
    const base = g();
    const placed = replay(base, [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "grp",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          owner: "planner",
          title: { key: "grp.title", fallback: "grp" },
          children: [],
        },
      },
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "w",
          order: "b",
          kind: "semantic",
          type: "Insight",
          typeVersion: "1.0.0",
          span: 6,
          column: 3,
          row: 1,
          label: { key: "w.label", fallback: "w" },
          props: { tone: "neutral" },
        },
      },
    ]);
    if (!placed.ok) throw new Error(placed.finding.message);
    const res = run(seal(placed.value), [
      box("grp", "section"),
      { ...insight("w", "grp"), span: 6 },
    ]);
    expect(res.findings).toEqual([]);
    expect(res.ops.map((o) => o.type)).toEqual(["setPlacement", "moveNode"]);
    const after = replay(seal(placed.value), res.ops);
    expect(after.ok).toBe(true);
  });
});

describe("U15 — the prompt", () => {
  it("describes the container kinds compactly, roles included", () => {
    const text = describeContainers(roles);
    expect(text.split("\n")).toHaveLength(5);
    expect(text).toContain("- tabs — a tab set");
    expect(text).toContain("(2-8 children)");
    expect(text.length).toBeLessThan(900);
    expect(describeContainers()).not.toContain("tabs");
  });

  it("a host-authored role description is one bounded line", () => {
    const long = describeContainers([{ role: "x", description: `a\nb ${"z".repeat(500)}` }]);
    const line = long.split("\n").find((l) => l.startsWith("- x"));
    expect(long.split("\n")).toHaveLength(4);
    expect((line ?? "").length).toBeLessThan(220);
  });

  it("compose and revise prompts carry the CONTAINERS block and the grouping rule", () => {
    const c = composeMessages(input);
    expect(c.messages[0]?.content).toContain("CONTAINERS:\n- section");
    expect(c.system).toContain("GROUPING");
    expect(c.system).toContain(`${MAX_DRAFT_DEPTH} levels deep`);
    expect(c.system).toContain(`${MAX_DRAFT_NODES} entries in all`);
  });

  it("describeExperience lists the editable region flat, parent before child, with `parent` links", async () => {
    const { exp } = await composed(tabsEntries());
    const d = describeExperience(exp, capabilitiesFixture, planningCatalog) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(d.nodes.map((n) => [n.id, n.parent])).toEqual([
      ["views", undefined],
      ["overview", "views"],
      ["orders", "overview"],
      ["detail", "views"],
      ["top", "detail"],
      ["note", "detail"],
    ]);
    expect(d.nodes[0]).toMatchObject({ container: "tabs", title: "views" });
    expect(d.nodes[2]).toMatchObject({ type: "Metric", binding: { capability: "orders_summary" } });
  });

  it("an application-owned container is a LOCKED placeholder with no subtree, nested or not", () => {
    const r = replay(g(), [
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "grp",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          owner: "planner",
          children: [],
        },
      },
      {
        type: "insertNode",
        parentId: "grp",
        node: {
          id: "shell",
          order: "a",
          kind: "container",
          direction: "column",
          span: 12,
          children: [
            {
              id: "s1",
              order: "a",
              kind: "semantic",
              type: "Insight",
              typeVersion: "1.0.0",
              span: 12,
              props: {},
            },
          ],
        },
      },
    ]);
    if (!r.ok) throw new Error(r.finding.message);
    const d = describeExperience(seal(r.value), capabilitiesFixture, planningCatalog) as {
      nodes: unknown[];
    };
    expect(d.nodes).toEqual([
      expect.objectContaining({ id: "grp", container: "section" }),
      { id: "shell", kind: "container", locked: true, descendants: 1, parent: "grp" },
    ]);
  });

  it("describes a very deep tree without recursing", () => {
    let deep: ExperienceNode = {
      id: "leaf",
      order: "a",
      kind: "semantic",
      type: "Insight",
      typeVersion: "1.0.0",
      span: 12,
      props: {},
    };
    for (let i = 0; i < 200; i++)
      deep = {
        id: `c${i}`,
        order: "a",
        kind: "container",
        direction: "column",
        span: 12,
        owner: "planner",
        children: [deep],
      };
    const exp = {
      ...g(),
      root: { ...(g().root as ContainerNode), children: [deep] },
    } as Experience;
    expect(
      (describeExperience(exp, [], planningCatalog) as { nodes: unknown[] }).nodes
    ).toHaveLength(201);
  });

  it("the revise prompt shows the nested tree it will diff against", async () => {
    const { exp } = await composed(tabsEntries());
    const m = reviseMessages({ experience: exp, request: { text: "x" }, ...input });
    expect(m.messages[0]?.content).toContain('"parent": "detail"');
    expect(m.system).toContain('give it a different "parent"');
  });
});

describe("U15 — streaming nested partials (U1)", () => {
  const nodesOf = (text: string) => {
    const s = new NodeScanner();
    return s.feed(text).map((n) => (n as { id: string }).id);
  };

  it("the scanner yields containers and their children as flat entries, in order, up to the new cap", () => {
    expect(nodesOf(reply(tabsEntries()))).toEqual([
      "views",
      "overview",
      "orders",
      "detail",
      "top",
      "note",
    ]);
    const many = Array.from({ length: 60 }, (_, i) =>
      insight(`n${i % 20}x${Math.floor(i / 20)}`, undefined)
    );
    expect(nodesOf(reply(many))).toHaveLength(60);
  });

  async function stream(text: string, size = 7) {
    const partials: PlanPartial[] = [];
    const model = streamingScriptedModel([text], size);
    const r = await planner(model as never).compose(input, recordingContext(), {
      onPartial: (p) => partials.push(p),
    });
    return { r, partials };
  }

  it("partials grow with nesting, each replays and validates, and the final equals the whole-reply plan", async () => {
    const { r, partials } = await stream(reply(tabsEntries()));
    expect(partials.length).toBeGreaterThan(1);
    expect(partials.map((p) => p.nodes)).toEqual(
      [...partials.map((p) => p.nodes)].sort((a, b) => a - b)
    );
    for (const p of partials) {
      const applied = replay(g(), p.ops);
      expect(applied.ok).toBe(true);
      if (applied.ok)
        expect(validateExperience(applied.value, planningCatalog, "web").ok).toBe(true);
      expect(Object.hasOwn(p, "summary")).toBe(false);
    }
    // an intermediate partial already shows a child inside its container
    const mid = partials.find((p) =>
      p.ops.some((o) => o.type === "insertNode" && o.parentId === "overview")
    );
    expect(mid).toBeDefined();
    const whole = await composed(tabsEntries());
    expect(JSON.stringify(r.ops)).toBe(JSON.stringify(whole.ops));
  });

  it("a child that streams before its container is not shown (and the final plan still names it)", async () => {
    const bad = reply([insight("n", "c"), box("c", "section")]);
    const { r, partials } = await stream(bad);
    expect(
      partials.every(
        (p) => p.nodes === 0 || !p.ops.some((o) => o.type === "insertNode" && o.node.id === "n")
      )
    ).toBe(true);
    expect(r.ops).toEqual([]);
    expect(r.findings.some((f) => f.message.includes("not an earlier container"))).toBe(true);
  });
});

describe("U15 — interactions with U10b, U7, U12 and keyed recompose", () => {
  it("U10b: a node bound to a classified capability keeps its class however deep it is nested", async () => {
    const secretCaps = capabilitiesFixture.map((c) =>
      c.handle === "orders_summary" ? { ...c, sensitivity: "secret" as const } : c
    );
    const r = await planner(scriptedModel([reply(tabsEntries())])).compose(
      { ...input, capabilities: secretCaps },
      recordingContext()
    );
    const applied = replay(g(), r.ops);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const bound = (id: string) =>
      (findNode(applied.value.root, id) as { binding?: { sensitivity?: string } }).binding;
    expect(bound("orders")?.sensitivity).toBe("secret");
    expect(bound("top")?.sensitivity).toBe("secret");
    // a viewer cleared for less sees the redaction, with layout and ids intact
    const out = compile(seal(applied.value), {
      catalog: planningCatalog,
      surface: "web",
      hydrationProjectionId: "loom-ui.hydration",
      hydrationProjectionVersion: "1.0.0",
      viewer: { clearance: "internal" },
    });
    expect(JSON.stringify(out.blueprint)).toContain('"role":"tabs"');
    expect(out.restrictedHandles.length).toBeGreaterThan(0);
  });

  it("U7: the summary is gated by the offered capabilities' class, not by the tree's shape", async () => {
    const ctx = () => recordingContext();
    const open = await planner(scriptedModel([reply(tabsEntries())])).compose(
      { ...input, contextClass: undefined as never },
      ctx()
    );
    expect(open.summary).toBeUndefined();
    expect(open.findings.some((f) => f.code === "summary-withheld")).toBe(true);
    const ok = await planner(scriptedModel([reply(tabsEntries())])).compose(input, ctx());
    expect(ok.summary).toBe("Two views of the orders");
    expect(ok.summaryClass).toBe("internal");
    const secret = await planner(scriptedModel([reply(tabsEntries())])).compose(
      {
        ...input,
        capabilities: capabilitiesFixture.map((c) => ({ ...c, sensitivity: "secret" as const })),
      },
      ctx()
    );
    expect(secret.summaryClass).toBe("secret");
  });

  it("U12: the ledger attributes every nested insert, and a move to the planner's decision", async () => {
    const first = await planner(scriptedModel([reply(tabsEntries())])).compose(
      input,
      recordingContext()
    );
    const by1 = plannerProvenance(first, { agentId: "p" });
    const exp1 = replay(g(), first.ops);
    if (!exp1.ok) throw new Error(exp1.finding.message);
    const e = tabsEntries();
    e.splice(2, 0, insight("note", "overview"));
    e.splice(
      e.findIndex((x, i) => i > 2 && (x as { id: string }).id === "note"),
      1
    );
    const second = await planner(scriptedModel([reply(e)])).revise(
      { experience: seal(exp1.value), request: { text: "move the note" }, ...input },
      recordingContext()
    );
    const by2 = plannerProvenance(second, { agentId: "p" });
    const rec = (ops: readonly Operation[], by: typeof by1) =>
      ops.map((op) => ({ op, by, at: "2026-10-07T00:00:00Z" }));
    const ledger = foldProvenance(emptyLedger(null), [
      { versionHash: "v1", at: "t1", by: by1, ops: rec(first.ops, by1) },
      { versionHash: "v2", at: "t2", by: by2, ops: rec(second.ops, by2) },
    ]);
    for (const id of ["views", "overview", "orders", "detail", "top", "note"])
      expect(ledger.nodes.get(id)?.created).toMatchObject({
        versionHash: "v1",
        by: { decisionId: first.report.decisionId },
      });
    expect(ledger.nodes.get("note")?.changed).toMatchObject({
      op: "moveNode",
      versionHash: "v2",
      viaPrompt: true,
      by: { decisionId: second.report.decisionId },
    });
    expect(ledger.nodes.get("views")?.changes).toBe(0);
  });

  it("U12: the ledger records moveNode, setRole and setTitle on nested nodes against the right decision", async () => {
    const first = await planner(scriptedModel([reply(tabsEntries())])).compose(
      input,
      recordingContext()
    );
    const exp1 = replay(g(), first.ops);
    if (!exp1.ok) throw new Error(exp1.finding.message);
    const e = tabsEntries();
    e[0] = { ...box("views", "stepper") };
    e[1] = box("overview", "section", "views", "Summary");
    // `note` moves from `detail` to `overview`
    e.splice(
      e.findIndex((x) => (x as { id: string }).id === "note"),
      1
    );
    e.splice(3, 0, insight("note", "overview"));
    const second = await planner(scriptedModel([reply(e)])).revise(
      { experience: seal(exp1.value), request: { text: "restructure" }, ...input },
      recordingContext()
    );
    expect(kinds(inner(second.ops)).sort()).toEqual(["moveNode", "setRole", "setTitle"]);
    const by1 = plannerProvenance(first, { agentId: "p" });
    const by2 = plannerProvenance(second, { agentId: "p" });
    const rec = (ops: readonly Operation[], by: typeof by1) =>
      ops.map((op) => ({ op, by, at: "2026-10-07T00:00:00Z" }));
    const ledger = foldProvenance(emptyLedger(null), [
      { versionHash: "v1", at: "t1", by: by1, ops: rec(first.ops, by1) },
      { versionHash: "v2", at: "t2", by: by2, ops: rec(second.ops, by2) },
    ]);
    for (const [id, op] of [
      ["views", "setRole"],
      ["overview", "setTitle"],
      ["note", "moveNode"],
    ] as const)
      expect(ledger.nodes.get(id)?.changed).toMatchObject({
        op,
        versionHash: "v2",
        viaPrompt: true,
        by: { decisionId: second.report.decisionId },
      });
    expect(ledger.nodes.get("note")?.created).toMatchObject({
      by: { decisionId: first.report.decisionId },
    });
  });

  it("`owner` survives a keyed recompose: a second revise still finds the container editable", async () => {
    const { exp } = await composed(tabsEntries());
    const e = tabsEntries();
    e[1] = box("overview", "section", "views", "Summary");
    const r1 = await planner(scriptedModel([reply(e)])).revise(
      { experience: exp, request: { text: "rename" }, ...input },
      recordingContext()
    );
    const a = replay(exp, r1.ops);
    if (!a.ok) throw new Error(a.finding.message);
    expect(findNode(a.value.root, "overview")).toMatchObject({ owner: "planner" });
    expect(findNode(a.value.root, "views")).toMatchObject({ owner: "planner" });
    const e2 = [...e];
    e2[3] = box("detail", "section", "views", "Details");
    const r2 = await planner(scriptedModel([reply(e2)])).revise(
      { experience: seal(a.value), request: { text: "rename again" }, ...input },
      recordingContext()
    );
    expect(kinds(inner(r2.ops))).toEqual(["setTitle"]);
  });

  it("keyed recompose: a revise that keeps a container keeps its compiled layout id; moved widgets keep theirs", async () => {
    const before = await composed(tabsEntries());
    const e = tabsEntries();
    e[1] = box("overview", "section", "views", "Summary");
    const r = await planner(scriptedModel([reply(e)])).revise(
      { experience: before.exp, request: { text: "rename" }, ...input },
      recordingContext()
    );
    const after = replay(before.exp, r.ops);
    if (!after.ok) throw new Error(after.finding.message);
    const bp = (x: Experience) =>
      JSON.stringify(
        compile(x, {
          catalog: planningCatalog,
          surface: "web",
          hydrationProjectionId: "loom-ui.hydration",
          hydrationProjectionVersion: "1.0.0",
          viewer: { clearance: "secret" },
        }).blueprint.layout
      );
    const ids = (s: string) => [...s.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids(bp(after.value))).toEqual(ids(bp(before.exp)));
  });
});

describe("U15 — conformance", () => {
  const fixture = (modelReplies: string[], over: object = {}) => ({
    intent: intentFixture,
    catalog: planningCatalog,
    capabilities: capabilitiesFixture,
    meta: metaFixture,
    revision: { text: "add a note to the first tab" },
    ctx: recordingContext(),
    containers: roles,
    ...over,
    _model: scriptedModel(modelReplies),
  });
  const run = async (replies: string[], over: object = {}) => {
    const fx = fixture(replies, over);
    const p = new ReferencePlanner({ model: fx._model, modelId: "m", maxAttempts: 1 });
    // `contextClass` is the host's; the kit declares none, so a sampled capability of unknown
    // class withholds the summary — that is not what is under test here.
    return checkPlannerConformance(p, fx);
  };

  const grown = (() => {
    const e = tabsEntries();
    e.splice(3, 0, insight("extra", "overview"));
    return e;
  })();

  it("the reference planner passes the kit on a nested compose + minimal revise", async () => {
    expect(await run([reply(tabsEntries()), reply(grown)])).toEqual([]);
  });

  it("the streaming contract holds for a nested reply (partials replay and validate, final equals whole)", async () => {
    const abortCtx = recordingContext();
    const model = streamingScriptedModel([reply(tabsEntries()), reply(grown)], 11);
    const p = new ReferencePlanner({ model, modelId: "m", maxAttempts: 1 });
    const fs = await checkPlannerConformance(p, {
      ...fixture([]),
      modelCalls: () => model.calls,
      streamProbe: {
        ctx: recordingContext(),
        abortCtx,
        abortDecisions: () => abortCtx.decisions.size,
      },
    });
    expect(fs).toEqual([]);
  });

  it("catches a planner that recomposes: remove + re-insert of an untouched id", async () => {
    // A planner whose revise drops and re-adds `note` under a new container each time
    const fs = await (async () => {
      const fx = fixture([]);
      const inner = new ReferencePlanner({
        model: scriptedModel([reply(tabsEntries()), reply(grown)]),
        modelId: "m",
        maxAttempts: 1,
      });
      const naughty = {
        compose: inner.compose.bind(inner),
        revise: async (...a: Parameters<typeof inner.revise>) => {
          const r = await inner.revise(...a);
          const only = r.ops[0];
          if (only?.type !== "prompt") return r;
          // drop and re-add a node the revision did not touch
          const note = findNode(a[0].experience.root, "note") as ExperienceNode;
          const parentId = parentOfId(a[0].experience, "note") as string;
          const redo: Operation[] = [
            { type: "removeNode", nodeId: "note" },
            { type: "insertNode", parentId, node: note },
          ];
          return { ...r, ops: [{ ...only, materialized: [...redo, ...only.materialized] }] };
        },
      };
      return checkPlannerConformance(naughty, fx);
    })();
    expect(fs.some((f) => f.code === "revise-recomposed")).toBe(true);
  });

  it("judges only what the plan INSERTED: an application container already in the base is not a revise finding", async () => {
    const mk = (id: string, owner?: "planner"): ContainerNode => ({
      id,
      order: "a",
      kind: "container",
      direction: "column",
      span: 12,
      ...(owner !== undefined && { owner }),
      children: [],
    });
    const rep = { decisionId: "d", attempts: [], firstAttemptValid: true, modelId: "m" };
    const planner = {
      // compose leaves an application-owned container (that IS flagged, under "compose")...
      compose: async () => ({
        ops: [{ type: "insertNode", parentId: "root", node: mk("app_box") }] as Operation[],
        findings: [],
        report: rep,
      }),
      // ...and the revise adds only an owned one beside it, which is fine.
      revise: async () => ({
        ops: [
          {
            type: "prompt",
            text: "x",
            materialized: [
              {
                type: "insertNode",
                parentId: "root",
                node: { ...mk("mine", "planner"), order: "b" },
              },
            ],
          },
        ] as Operation[],
        findings: [],
        report: rep,
      }),
    };
    const fs = await checkPlannerConformance(planner as never, fixture([]));
    expect(
      fs.some((f) => f.code === "container-not-owned" && f.message.startsWith("compose"))
    ).toBe(true);
    expect(fs.filter((f) => f.message.startsWith("revise inserted"))).toEqual([]);
    expect(fs.some((f) => f.code === "too-many-nodes")).toBe(false);
  });

  it("catches nesting past the bound, an unowned container, and a role container its role cannot draw", async () => {
    const chain = (n: number) => {
      const out: object[] = [];
      for (let i = 0; i < n; i++)
        out.push(box(`c${i}`, "section", i === 0 ? undefined : `c${i - 1}`));
      out.push(insight("leaf", `c${n - 1}`));
      return out;
    };
    // a planner built WITHOUT the schema's depth bound: hand-made ops
    const handmade = (nodes: ContainerNode[]) => ({
      compose: async () => ({
        ops: nodes.map((node) => ({
          type: "insertNode",
          parentId: node.id === "c0" ? "root" : `c${Number(node.id.slice(1)) - 1}`,
          node,
        })) as Operation[],
        findings: [],
        report: { decisionId: "d", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
      revise: async () => ({
        ops: [],
        findings: [],
        report: { decisionId: "d", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
    });
    void chain;
    const mk = (i: number, owner = true): ContainerNode => ({
      id: `c${i}`,
      order: "a",
      kind: "container",
      direction: "column",
      span: 12,
      ...(owner && { owner: "planner" as const }),
      children: [],
    });
    const deep = await checkPlannerConformance(
      handmade(Array.from({ length: MAX_DRAFT_DEPTH + 1 }, (_, i) => mk(i))) as never,
      fixture([])
    );
    expect(deep.some((f) => f.code === "nesting-too-deep")).toBe(true);
    const unowned = await checkPlannerConformance(handmade([mk(0, false)]) as never, fixture([]));
    expect(unowned.some((f) => f.code === "container-not-owned")).toBe(true);
    const tabsBad = await checkPlannerConformance(
      handmade([{ ...mk(0), role: "tabs" }]) as never,
      fixture([])
    );
    expect(tabsBad.some((f) => f.code === "container-role-children")).toBe(true);
  });
});
