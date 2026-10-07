import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { inspectExperience } from "./change";
import { compile } from "./compile";
import { genesis } from "./experience";
import { walk } from "./node";
import { mayView } from "./viewer";

// PROPERTY: compile and the readers AGREE on which containers are hidden. A container is hidden iff
// compile draws it as a bare placeholder (or omits it) for a viewer, and `inspectExperience` reads
// it as blocked or above that viewer's clearance. Randomised, seeded trees (depth <= 4) of bound,
// tool-backed, static, refused, offered, unknown, stale and unresolvable children, empty containers
// and per-node classes that DIFFER on one shared projection (the readers must derive the class the
// way compile does), against four viewers. A defect found here is a viewer-visible disagreement
// between what is drawn and what is explained.

const catalog = defineSemanticCatalog({
  id: "t",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" } },
    },
    {
      name: "Proj",
      version: "1.0.0",
      props: [],
      binding: "optional",
      surfaces: { web: { kind: "MetricCard" } },
    },
    {
      name: "Static",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { kind: "Note", props: [], binding: "none" } },
    },
  ],
});
type Cls = "internal" | "sensitive" | "secret" | undefined;
const CLS: Cls[] = [undefined, "internal", "sensitive", "secret"];
const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };

function rng(seed: number) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return { next, pick: <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)] as T };
}

// biome-ignore lint/suspicious/noExplicitAny: a generator of deliberately loose nodes
type Any = any;

function generate(seed: number) {
  const { next, pick } = rng(seed);
  let n = 0;
  const providers: Record<string, unknown> = {};
  const provider = (h: string, tool?: string) => {
    providers[h] = {
      handle: h,
      executionGraph: tool
        ? [
            {
              stepId: "s",
              toolName: tool,
              toolVersion: "1",
              toolSchemaHash: "x",
              arguments: {},
              dependsOn: [],
              idempotent: true,
            },
          ]
        : [],
      reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" },
    };
  };
  const leaf = (): Any => {
    const id = `n${n++}`;
    const base = { id, order: id, kind: "semantic", typeVersion: "1.0.0", span: 6, props: {} };
    const k = pick([
      "bind",
      "bind",
      "bind",
      "projOk",
      "projUnknown",
      "projStale",
      "unresolvable",
      "refused",
      "tool",
      "static",
    ]);
    const c = pick(CLS);
    if (k === "bind" || k === "tool" || k === "unresolvable") {
      provider(`h${id}`, k === "tool" ? pick(["tA", "tB"]) : undefined);
      return {
        ...base,
        type: k === "unresolvable" ? "Nope" : "Metric",
        binding: { handle: `h${id}`, priority: "P1", ...(c && { sensitivity: c }) },
      };
    }
    if (k === "static") return { ...base, type: "Static" };
    const pid = k === "projOk" ? pick(["pA", "pB"]) : k === "projUnknown" ? "pZ" : "pA";
    const out: Any = {
      ...base,
      type: "Proj",
      projection: {
        id: pid,
        version: k === "projStale" ? "9" : "1",
        path: "x",
        ...(c && { sensitivity: c }),
      },
    };
    if (k === "refused") {
      provider(`h${id}`);
      out.binding = { handle: `h${id}`, priority: "P1" };
      out.type = "Metric";
    }
    return out;
  };
  const tree = (depth: number): Any => {
    const id = `c${n++}`;
    const m = depth >= 4 ? 0 : Math.floor(next() * 4);
    const children: Any[] = [];
    for (let i = 0; i < m; i++) children.push(depth < 3 && next() < 0.4 ? tree(depth + 1) : leaf());
    return {
      id,
      order: id,
      kind: "container",
      direction: pick(["column", "row", "grid"]),
      span: 12,
      title: { key: "t", fallback: `T-${id}` },
      children,
    };
  };
  const root = tree(0);
  root.order = "V";
  const exp = {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root,
    providers,
  } as Any;
  const projections = [
    {
      id: "pA",
      version: "1",
      ...(next() < 0.5 && { sensitivity: pick(["internal", "secret"] as const) }),
    },
    { id: "pB", version: "1" },
  ];
  const tc =
    next() < 0.3
      ? {
          declaredToolClasses: { tA: pick(["internal", "secret"] as const) },
          undeclared: pick(["allow", "deny"] as const),
        }
      : {};
  return { exp, root, projections, tc };
}

describe("compile and the readers agree on which containers are hidden (property)", () => {
  it("0 mismatches over 500 randomised trees x 4 viewers", () => {
    const viewers = [
      undefined,
      { clearance: "internal" as const },
      { clearance: "sensitive" as const },
      { clearance: "secret" as const },
    ];
    const bad: string[] = [];
    let total = 0;
    let hiddenSeen = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const { exp, root, projections, tc } = generate(seed);
      const ins = inspectExperience(exp, {
        projections,
        hydrationProjectionId: "hydration",
        ...tc,
      });
      for (const viewer of viewers) {
        total++;
        const r = compile(exp, {
          surface: "web",
          catalog,
          hydrationProjectionId: "hydration",
          hydrationProjectionVersion: "1",
          projections,
          ...(viewer !== undefined && { viewer }),
          ...tc,
        });
        const present = new Set<string>();
        const placeholders = new Set<string>();
        const vis = (x: Any): void => {
          if (x.id) present.add(x.id);
          if (x.kind === "Note" && String(x.id).startsWith("c")) placeholders.add(x.id);
          for (const ch of x.children ?? []) vis(ch.node ?? ch);
          if (x.node) vis(x.node);
        };
        vis(r.blueprint.layout);
        const collapsed = new Set(placeholders);
        walk(root, (x) => {
          if (x.kind === "container" && !present.has(x.id)) collapsed.add(x.id);
        });
        const hidden = new Set<string>();
        for (const [id, v] of ins.nodes)
          if (id.startsWith("c") && (v.blocked || !mayView(viewer, v.cls))) hidden.add(id);
        // The root is the frame; a hidden root reads as a placeholder too and is compared like any.
        hiddenSeen += hidden.size;
        for (const id of collapsed)
          if (!hidden.has(id))
            bad.push(`seed ${seed} ${viewer?.clearance}: compile hides ${id}, readers show it`);
        for (const id of hidden)
          if (!collapsed.has(id))
            bad.push(`seed ${seed} ${viewer?.clearance}: readers hide ${id}, compile shows it`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(total).toBe(2000);
    expect(hiddenSeen).toBeGreaterThan(100); // the generator does exercise hidden containers
  });
});

// ── Pinned cases ─────────────────────────────────────────────────────────────────────────────
const low = { clearance: "internal" as const };
const proj = (id: string, p: string, v = "1", sensitivity?: "secret"): Any => ({
  id,
  order: id,
  kind: "semantic",
  type: "Proj",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  projection: { id: p, version: v, path: "x", ...(sensitivity && { sensitivity }) },
});
const bound = (id: string, sensitivity?: "secret", type = "Metric"): Any => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: `h${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const box = (id: string, children: Any[]): Any => ({
  id,
  order: id,
  kind: "container",
  direction: "column",
  span: 12,
  title: { key: "t", fallback: `T-${id}` },
  children,
});
function exp(children: Any[]): Any {
  const providers: Record<string, unknown> = {};
  walk(
    { id: "r", order: "V", kind: "container", direction: "column", span: 12, children } as Any,
    (n) => {
      if (n.kind === "semantic" && n.binding)
        providers[n.binding.handle] = {
          handle: n.binding.handle,
          executionGraph: [],
          reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
          outputShapeHash: "sha256:o",
          cachePolicy: { ttlSeconds: 60, scope: "global" },
        };
    }
  );
  return {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root: box("root", children),
    providers,
  };
}
const projections = [{ id: "pA", version: "1" }];
const copts = {
  surface: "web" as const,
  catalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1",
  projections,
};
const ids = (r: ReturnType<typeof compile>): string => JSON.stringify(r.blueprint.layout);
const read = (e: Any, id: string, viewer = low) => {
  const v = inspectExperience(e, { projections, hydrationProjectionId: "hydration" }).nodes.get(id);
  return v !== undefined && (v.blocked || !mayView(viewer, v.cls));
};

describe("U15 round 3: the exact collapse rule", () => {
  it("a container of only BLOCKED children (unknown / stale projection) is bare for everyone, on both paths", () => {
    const e = exp([box("k", [proj("a", "pZ"), proj("b", "pA", "9")]), bound("pub")]);
    for (const viewer of [undefined, { clearance: "secret" as const }]) {
      const r = compile(e, { ...copts, ...(viewer !== undefined && { viewer }) });
      expect(ids(r)).not.toContain("T-k");
      expect(ids(r)).not.toContain('"a"');
      expect(read(e, "k", viewer as Any)).toBe(true);
    }
  });

  it("blocked + a visible child stays visible; blocked + a restricted child reads as the restricted class", () => {
    const vis = exp([box("k", [proj("a", "pZ"), bound("v")])]);
    expect(ids(compile(vis, { ...copts, viewer: low }))).toContain("T-k");
    expect(read(vis, "k")).toBe(false);
    const res = exp([box("k", [proj("a", "pZ"), bound("s", "secret")])]);
    expect(ids(compile(res, { ...copts, viewer: low }))).not.toContain("T-k");
    expect(read(res, "k")).toBe(true);
  });

  it("a REFUSED child is ignored (omitted by compile, not counted by the readers)", () => {
    const refused = { ...proj("r", "pA"), binding: { handle: "hr", priority: "P1" } };
    const e = exp([box("k", [refused, bound("s", "secret")])]);
    expect(ids(compile(e, { ...copts, viewer: low }))).not.toContain("T-k");
    expect(read(e, "k")).toBe(true);
    const only = exp([box("k", [refused])]); // nothing counted: stays as authored
    expect(ids(compile(only, { ...copts, viewer: low }))).toContain("T-k");
    expect(read(only, "k")).toBe(false);
  });

  it("a child dropped for a NON-projection reason (unresolvable) keeps the container visible", () => {
    const e = exp([box("k", [bound("gone", undefined, "Nope"), bound("s", "secret")])]);
    const r = compile(e, { ...copts, viewer: low });
    expect(ids(r)).toContain("T-k");
    expect(read(e, "k")).toBe(false);
  });

  it("the findings of a collapsed container name only the container, not the children it hides", () => {
    const e = exp([
      box("k", [bound("a", "secret"), box("m", [bound("b", "secret")])]),
      bound("pub"),
    ]);
    const r = compile(e, { ...copts, viewer: low });
    const restricted = r.findings.filter((f) => f.code === "node-restricted").map((f) => f.nodeId);
    expect(restricted).toEqual(["k"]);
  });

  it("a projection's class is ONE value for every node binding it: the readers use compile's derivation", () => {
    // `a` carries the class on the shared projection; `b` does not. Compile restricts both.
    const e = exp([box("ka", [proj("a", "pA", "1", "secret")]), box("kb", [proj("b", "pA")])]);
    const r = compile(e, { ...copts, viewer: low });
    expect(ids(r)).not.toContain("T-kb");
    expect(read(e, "kb")).toBe(true);
    expect(
      inspectExperience(e, { projections, hydrationProjectionId: "hydration" }).nodes.get("b")?.cls
    ).toBe("secret");
  });
});
